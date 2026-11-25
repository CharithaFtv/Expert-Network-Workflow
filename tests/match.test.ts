import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { pollInbox } from "@/lib/mail/inbound";
import type { InboundMessage, InboxReader } from "@/lib/mail/inbox";
import { assignToProject, domainOf, matchPending, referencedIds } from "@/lib/mail/match";
import { createProject } from "@/lib/projects";
import { ALICE, person, resetDb, validBrief } from "./helpers";

beforeEach(resetDb);

async function project(vendorIds = [1]) {
  const r = await createProject(validBrief({ vendorIds }), person(ALICE));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const [p] = await db.query<{ id: number; code: string }>("SELECT id, code FROM projects WHERE id = $1", [r.id]);
  return p;
}

let n = 0;
/** Puts a received message in the table, as the poller would. Times increase so order is predictable. */
async function inbound(over: Partial<{
  subject: string;
  from: string;
  conversation: string | null;
  messageId: string;
  headers: { name: string; value: string }[] | null;
}> = {}) {
  n++;
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages
       (graph_id, internet_message_id, conversation_id, received_at, from_address, subject, headers, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      `g${n}`,
      over.messageId ?? `<m${n}@vendor.test>`,
      over.conversation === undefined ? null : over.conversation,
      new Date(Date.UTC(2026, 10, 24, 10, 0, n)).toISOString(),
      over.from ?? "intake1@vendor.test",
      over.subject ?? "hello",
      over.headers ? JSON.stringify(over.headers) : null,
      new Date().toISOString(),
    ],
  );
  return row.id;
}

type Out = {
  status: string;
  project_id: number | null;
  vendor_id: number | null;
  match_method: string | null;
  sender_verified: boolean | null;
};
const outcome = async (id: number) =>
  (await db.query<Out>(
    "SELECT status, project_id, vendor_id, match_method, sender_verified FROM inbound_messages WHERE id = $1",
    [id],
  ))[0];

describe("matching by subject code", () => {
  it("matches the code, finds the vendor by its exact address, and verifies the sender", async () => {
    const p = await project();
    const id = await inbound({ subject: `Re: [${p.code}] Wholesale distributor software` });
    await matchPending();
    expect(await outcome(id)).toEqual({
      status: "Matched",
      project_id: p.id,
      vendor_id: 1,
      match_method: "subject_code",
      sender_verified: true,
    });
  });

  it("ignores the case of the code", async () => {
    const p = await project();
    const id = await inbound({ subject: `re: [${p.code.toLowerCase()}] x` });
    await matchPending();
    expect((await outcome(id)).project_id).toBe(p.id);
  });

  it("sends an unknown code to a person instead of guessing", async () => {
    await project();
    const id = await inbound({ subject: "Re: [EN-2026-9999] x" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Unmatched", project_id: null, match_method: null });
  });
});

describe("sender check", () => {
  it("flags a sender whose domain is not a vendor on the project, and keeps the project", async () => {
    const p = await project();
    const id = await inbound({ subject: `[${p.code}] x`, from: "someone@stranger.test" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({
      status: "Unverified",
      project_id: p.id,
      vendor_id: null,
      sender_verified: false,
    });
  });

  it("verifies another address on the vendor's domain, naming the only vendor there", async () => {
    const p = await project();
    const id = await inbound({ subject: `[${p.code}] x`, from: "analyst@vendor.test" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Matched", vendor_id: 1, sender_verified: true });
  });

  it("verifies but names no vendor when two vendors on the project share the domain", async () => {
    await db.query("UPDATE vendors SET intake_email = 'intake2@vendor.test' WHERE id = 2");
    const p = await project([1, 2]);
    const id = await inbound({ subject: `[${p.code}] x`, from: "analyst@vendor.test" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Matched", vendor_id: null, sender_verified: true });
  });

  it("accepts a domain added to the vendor's extra domains", async () => {
    await db.query("UPDATE vendors SET domains = '{other.test}' WHERE id = 1");
    const p = await project();
    const id = await inbound({ subject: `[${p.code}] x`, from: "x@OTHER.test" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Matched", vendor_id: 1 });
  });

  it("accepts any vendor on the list, but names only a vendor that is on the project", async () => {
    await db.query("UPDATE vendors SET intake_email = 'intake2@other2.test' WHERE id = 2");
    const p = await project([1]); // vendor 2 is on the list but not on this project
    const id = await inbound({ subject: `[${p.code}] x`, from: "intake2@other2.test" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Matched", vendor_id: null, sender_verified: true });
  });

  it("does not accept the domain of an inactive vendor", async () => {
    await db.query("UPDATE vendors SET intake_email = 'intake2@other2.test', active = 0 WHERE id = 2");
    const p = await project([1]);
    const id = await inbound({ subject: `[${p.code}] x`, from: "intake2@other2.test" });
    await matchPending();
    expect((await outcome(id)).status).toBe("Unverified");
  });

  it("treats a missing sender as unverified", async () => {
    const p = await project();
    const id = await inbound({ subject: `[${p.code}] x`, from: "not-an-address" });
    await matchPending();
    expect((await outcome(id)).status).toBe("Unverified");
  });
});

describe("matching a thread", () => {
  it("learns the conversation from a matched message and uses it when the code is gone", async () => {
    const p = await project();
    const first = await inbound({ subject: `[${p.code}] x`, conversation: "c1" });
    const reply = await inbound({ subject: "Re: Re: Fwd: shortlist", conversation: "c1" });
    await matchPending();
    expect(await outcome(first)).toMatchObject({ match_method: "subject_code" });
    expect(await outcome(reply)).toMatchObject({ status: "Matched", project_id: p.id, match_method: "conversation" });
  });

  it("does not learn a conversation from an unverified message", async () => {
    const p = await project();
    await inbound({ subject: `[${p.code}] x`, from: "x@stranger.test", conversation: "c2" });
    const later = await inbound({ subject: "no code", conversation: "c2" });
    await matchPending();
    expect(await outcome(later)).toMatchObject({ status: "Unmatched", project_id: null });
  });

  it("matches through In-Reply-To and References", async () => {
    const p = await project();
    await inbound({ subject: `[${p.code}] x`, messageId: "<orig@vendor.test>", conversation: "c3" });
    const viaHeader = await inbound({
      subject: "no code",
      conversation: "other-conversation",
      headers: [
        { name: "In-Reply-To", value: "<orig@vendor.test>" },
        { name: "References", value: "<root@x> <orig@vendor.test>" },
      ],
    });
    await matchPending();
    expect(await outcome(viaHeader)).toMatchObject({ status: "Matched", project_id: p.id, match_method: "header" });
  });

  it("leaves a message with no code, thread or reply headers for a person", async () => {
    await project();
    const id = await inbound({ subject: "random hello", conversation: "c4" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Unmatched", sender_verified: true });
  });
});

describe("matchPending", () => {
  it("is idempotent and leaves finished messages alone", async () => {
    const p = await project();
    await inbound({ subject: `[${p.code}] x` });
    await inbound({ subject: "nothing" });
    expect(await matchPending()).toEqual({ matched: 1, unverified: 0, unmatched: 1 });
    expect(await matchPending()).toEqual({ matched: 0, unverified: 0, unmatched: 0 });
  });
});

describe("assignToProject", () => {
  it("lets a person put an unmatched message on a project, with the sender check still applied", async () => {
    const p = await project();
    const good = await inbound({ subject: "no code" });
    const bad = await inbound({ subject: "no code either", from: "x@stranger.test" });
    await matchPending();
    await assignToProject(good, p.id);
    await assignToProject(bad, p.id);
    expect(await outcome(good)).toMatchObject({ status: "Matched", project_id: p.id, match_method: "manual" });
    expect(await outcome(bad)).toMatchObject({ status: "Unverified", project_id: p.id, match_method: "manual" });
  });

  it("refuses a missing message or project", async () => {
    const p = await project();
    await expect(assignToProject(99999, p.id)).rejects.toThrow(/No inbound message/);
    const id = await inbound();
    await expect(assignToProject(id, 99999)).rejects.toThrow(/No project/);
  });
});

describe("poll integration", () => {
  it("matches what a poll stored, and a dry run matches nothing", async () => {
    const p = await project();
    const m: InboundMessage = {
      graphId: "gx",
      internetMessageId: "<gx@vendor.test>",
      conversationId: "cx",
      receivedAt: "2026-11-24T10:00:00Z",
      fromAddress: "intake1@vendor.test",
      fromName: "V",
      toAddresses: [],
      subject: `Re: [${p.code}] x`,
      bodyType: "text",
      body: "hi",
      hasAttachments: false,
      headers: null,
    };
    const reader: InboxReader = {
      name: "test/inbox",
      async readChanges(_c, _s, onPage) {
        await onPage([m], null);
        return "d1";
      },
    };
    const dry = await pollInbox(reader, { dryRun: true });
    expect(dry.matching).toBeUndefined();
    const real = await pollInbox(reader);
    expect(real.matching).toEqual({ matched: 1, unverified: 0, unmatched: 0 });
  });
});

describe("helpers", () => {
  it("reads the domain of an address", () => {
    expect(domainOf("A@Vendor.Test")).toBe("vendor.test");
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf(null)).toBeNull();
  });

  it("lists the message IDs a reply points at, once each", () => {
    expect(
      referencedIds([
        { name: "In-Reply-To", value: "<a@x>" },
        { name: "references", value: "<b@x>\r\n <a@x>" },
        { name: "Subject", value: "<ignored@x>" },
      ]),
    ).toEqual(["<a@x>", "<b@x>"]);
    expect(referencedIds(null)).toEqual([]);
  });
});
