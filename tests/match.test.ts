import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pollInbox } from "@/lib/mail/inbound";
import type { InboundMessage, InboxReader } from "@/lib/mail/inbox";
import { assignToProject, domainOf, matchPending, referencedIds, senderAuthenticated } from "@/lib/mail/match";
import { createProject } from "@/lib/projects";
import { changeProjectStatus } from "@/lib/projectStatus";
import { ALICE, person, resetDb, validBrief } from "./helpers";

// Most tests here are about which project and vendor a message belongs to, so sender authentication is
// switched off for them; the "sender authentication" tests switch it back on.
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("SENDER_AUTH", "off");
});
afterEach(() => vi.unstubAllEnvs());

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

  it("does not fall back to the thread or reply headers when the subject names a project that does not exist", async () => {
    const p = await project();
    await inbound({ subject: `[${p.code}] x`, messageId: "<orig@vendor.test>", conversation: "c5" });
    const viaConversation = await inbound({ subject: "Re: [EN-2026-9999] typo", conversation: "c5" });
    const viaHeader = await inbound({
      subject: "Re: [EN-2026-9999] typo",
      conversation: "other",
      headers: [hdr("In-Reply-To", "<orig@vendor.test>")],
    });
    await matchPending();
    expect(await outcome(viaConversation)).toMatchObject({ status: "Unmatched", project_id: null });
    expect(await outcome(viaHeader)).toMatchObject({ status: "Unmatched", project_id: null });
  });

  it("matches a code whose number has grown past four digits", async () => {
    const p = await project();
    await db.query("UPDATE projects SET code = 'EN-2026-10000' WHERE id = $1", [p.id]);
    const id = await inbound({ subject: "Re: [EN-2026-10000] still ours" });
    await matchPending();
    expect(await outcome(id)).toMatchObject({ status: "Matched", project_id: p.id, match_method: "subject_code" });
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

  it("is not overwritten by an automatic match that was already under way", async () => {
    const a = await project();
    const b = await project();
    const id = await inbound({ subject: `[${a.code}] x` });
    const other = await inbound({ subject: "later one", conversation: "c9" }); // still handled normally
    // The matcher has read its list of waiting messages; before it saves this one, a person assigns it to B.
    const real = db.query.bind(db);
    let assigned = false;
    const spy = vi.spyOn(db, "query").mockImplementation(async (text: string, params?: unknown[]) => {
      if (!assigned && text.includes("FROM projects WHERE upper(code)")) {
        assigned = true;
        await assignToProject(id, b.id);
      }
      return real(text, params);
    });
    let counts;
    try {
      counts = await matchPending();
    } finally {
      spy.mockRestore();
    }
    expect(assigned).toBe(true);
    expect(await outcome(id)).toMatchObject({ status: "Matched", project_id: b.id, match_method: "manual" });
    expect(counts).toEqual({ matched: 0, unverified: 0, unmatched: 1 }); // only the other message was matched by the run
    expect((await outcome(other)).status).toBe("Unmatched");
  });

  it("still lets a person override an earlier automatic match", async () => {
    const a = await project();
    const b = await project();
    const id = await inbound({ subject: `[${a.code}] x` });
    await matchPending();
    await assignToProject(id, b.id);
    expect(await outcome(id)).toMatchObject({ project_id: b.id, match_method: "manual" });
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

const hdr = (name: string, value: string) => ({ name, value });

describe("sender authentication", () => {
  it("accepts internal mail or a DMARC pass, and nothing else", () => {
    const check = (headers: { name: string; value: string }[] | null) => senderAuthenticated(headers, {});
    expect(check([hdr("X-MS-Exchange-Organization-AuthAs", "Internal")])).toBe(true);
    expect(check([hdr("Authentication-Results", "mx.microsoft.com 1; spf=none; dkim=none; dmarc=pass action=none")])).toBe(true);
    expect(check([hdr("authentication-results", "mx; DMARC=Pass action=none")])).toBe(true);
    expect(check([hdr("Authentication-Results", "mx; spf=pass; dkim=none; dmarc=none")])).toBe(false);
    expect(check([hdr("Authentication-Results", "mx; dkim=fail; spf=fail; dmarc=fail")])).toBe(false);
    expect(check([hdr("Authentication-Results", "mx; dmarc=bestguesspass")])).toBe(false);
    expect(check([hdr("X-MS-Exchange-Organization-AuthAs", "Anonymous")])).toBe(false);
    expect(check([])).toBe(false);
    expect(check(null)).toBe(false);
  });

  it("does not accept SPF and DKIM passes for a domain that is not the From domain", () => {
    // The attacker owns evil.test: SPF and DKIM pass for it, but DMARC fails because it is not the From domain.
    const spoof = [
      hdr(
        "Authentication-Results",
        "mx.microsoft.com 1; spf=pass smtp.mailfrom=evil.test; dkim=pass header.d=evil.test; dmarc=fail action=none header.from=vendor.test",
      ),
    ];
    expect(senderAuthenticated(spoof, {})).toBe(false);
  });

  it("reads only the topmost Authentication-Results header, so one the sender included cannot vouch for itself", () => {
    const real = hdr("Authentication-Results", "mx.microsoft.com 1; dmarc=fail action=none header.from=vendor.test");
    const forged = hdr("Authentication-Results", "mx.microsoft.com 1; dmarc=pass action=none header.from=vendor.test");
    expect(senderAuthenticated([real, forged], {})).toBe(false); // the receiving server's header is on top
    expect(senderAuthenticated([forged, real], {})).toBe(true); // top header passes: that is what counts
  });

  it("can be switched off for local development", () => {
    expect(senderAuthenticated(null, { SENDER_AUTH: "off" })).toBe(true);
    expect(senderAuthenticated(null, { SENDER_AUTH: " OFF " })).toBe(true);
    expect(senderAuthenticated(null, { SENDER_AUTH: "require" })).toBe(false);
  });

  it("leaves a message from a known vendor domain Unverified until it is authenticated, and says why", async () => {
    vi.stubEnv("SENDER_AUTH", "");
    const p = await project();
    const subject = `[${p.code}] x`;
    const none = await inbound({ subject });
    const failed = await inbound({ subject, headers: [hdr("Authentication-Results", "mx; dmarc=fail; spf=fail; dkim=fail")] });
    const dmarc = await inbound({ subject, headers: [hdr("Authentication-Results", "mx; dmarc=pass action=none")] });
    const internal = await inbound({ subject, headers: [hdr("X-MS-Exchange-Organization-AuthAs", "Internal")] });
    await matchPending();
    expect((await outcome(none)).status).toBe("Unverified");
    expect((await outcome(failed)).status).toBe("Unverified");
    expect((await outcome(dmarc)).status).toBe("Matched");
    expect((await outcome(internal)).status).toBe("Matched");
    const [note] = await db.query<{ sender_note: string | null }>("SELECT sender_note FROM inbound_messages WHERE id = $1", [none]);
    expect(note.sender_note).toMatch(/not authenticated/);
    const [ok] = await db.query<{ sender_note: string | null }>("SELECT sender_note FROM inbound_messages WHERE id = $1", [dmarc]);
    expect(ok.sender_note).toBeNull();
  });
});

describe("personal-mail domains", () => {
  it("never identify a vendor by domain, only by the vendor's exact address", async () => {
    await db.query("UPDATE vendors SET intake_email = 'vendorperson@gmail.com', domains = '{gmail.com}' WHERE id = 1");
    const p = await project();
    const exact = await inbound({ subject: `[${p.code}] x`, from: "VendorPerson@gmail.com" });
    const other = await inbound({ subject: `[${p.code}] x`, from: "someoneelse@gmail.com" });
    await matchPending();
    expect(await outcome(exact)).toMatchObject({ status: "Matched", vendor_id: 1 });
    expect(await outcome(other)).toMatchObject({ status: "Unverified", vendor_id: null });
    const [note] = await db.query<{ sender_note: string }>("SELECT sender_note FROM inbound_messages WHERE id = $1", [other]);
    expect(note.sender_note).toMatch(/personal-mail/);
  });
});

describe("re-assigning a message", () => {
  it("does not carry one project's retention date to another project", async () => {
    const a = await project();
    const b = await project();
    const id = await inbound({ subject: `[${a.code}] x` });
    await matchPending();
    await changeProjectStatus(a.id, { id: ALICE, name: person(ALICE).name }, "Closed", { RETENTION_DAYS_AFTER_CLOSE: "0" });
    const dated = await db.query<{ retain_until: string | null }>("SELECT retain_until FROM inbound_messages WHERE id = $1", [id]);
    expect(dated[0].retain_until).not.toBeNull(); // dated because project A closed

    await assignToProject(id, b.id); // moved to open project B
    const after = await db.query<{ retain_until: string | null; project_id: number }>(
      "SELECT retain_until, project_id FROM inbound_messages WHERE id = $1",
      [id],
    );
    expect(after[0]).toEqual({ retain_until: null, project_id: b.id });
  });

  it("removes stored attachments when a message stops being verified, so they can be fetched again if it is verified later", async () => {
    const p = await project();
    const id = await inbound({ subject: `[${p.code}] x` });
    await matchPending();
    await db.query(
      `INSERT INTO inbound_attachments (message_id, graph_attachment_id, name, size_bytes, status, content, created_at)
       VALUES ($1, 'a', 'cv.pdf', 3, 'Stored', $2, $3)`,
      [id, Buffer.from("abc"), new Date().toISOString()],
    );
    await db.query("UPDATE inbound_messages SET attachments_fetched_at = $2 WHERE id = $1", [id, new Date().toISOString()]);

    await db.query("UPDATE vendors SET active = 0"); // the sender is no longer a known vendor
    const r = await assignToProject(id, p.id);
    expect(r.status).toBe("Unverified");
    expect((await db.query("SELECT 1 FROM inbound_attachments WHERE message_id = $1", [id])).length).toBe(0);
    const [m] = await db.query<{ attachments_fetched_at: string | null }>(
      "SELECT attachments_fetched_at FROM inbound_messages WHERE id = $1",
      [id],
    );
    expect(m.attachments_fetched_at).toBeNull();
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
