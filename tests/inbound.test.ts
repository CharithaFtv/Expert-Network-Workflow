import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { pollInbox } from "@/lib/mail/inbound";
import { CursorExpiredError, GraphInbox, type InboundMessage, type InboxReader } from "@/lib/mail/inbox";
import { resetDb } from "./helpers";

const msg = (n: number, over: Partial<InboundMessage> = {}): InboundMessage => ({
  graphId: `g${n}`,
  internetMessageId: `<m${n}@vendor.test>`,
  conversationId: "c1",
  receivedAt: "2026-11-24T10:00:00Z",
  fromAddress: "charitha@ftvcapital.com",
  fromName: "Charitha",
  toAddresses: ["testrequest@ftvcapital.com"],
  subject: `Re: [EN-2026-0004] ask ${n}`,
  bodyType: "text",
  body: "hello",
  hasAttachments: false,
  headers: null,
  ...over,
});

/** A reader that serves canned pages and records what cursor it was asked for. */
function fakeReader(pages: InboundMessage[][], link = "delta-1"): InboxReader & { calls: (string | null)[] } {
  const calls: (string | null)[] = [];
  return {
    calls,
    async readChanges(cursor, _since, onPage) {
      calls.push(cursor);
      for (const p of pages) await onPage(p);
      return link;
    },
  };
}

beforeEach(resetDb);

describe("pollInbox", () => {
  it("stores messages and saves the cursor", async () => {
    const r = await pollInbox(fakeReader([[msg(1), msg(2)], [msg(3)]]));
    expect(r).toEqual({ fetched: 3, stored: 3, duplicates: 0 });
    const [s] = await db.query<{ delta_link: string }>("SELECT delta_link FROM mailbox_sync");
    expect(s.delta_link).toBe("delta-1");
  });

  it("drops a repeated Graph ID and a repeated Message-ID", async () => {
    await pollInbox(fakeReader([[msg(1)]]));
    const r = await pollInbox(
      fakeReader([[msg(1), msg(9, { internetMessageId: "<m1@vendor.test>" }), msg(2)]]),
    );
    expect(r).toMatchObject({ fetched: 3, stored: 1, duplicates: 2 });
    const [c] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM inbound_messages");
    expect(c.n).toBe(2);
  });

  it("resumes from the saved cursor", async () => {
    await pollInbox(fakeReader([[msg(1)]], "delta-1"));
    const second = fakeReader([[msg(2)]], "delta-2");
    await pollInbox(second);
    expect(second.calls).toEqual(["delta-1"]);
  });

  it("keeps the old cursor when a page fails, and replays safely", async () => {
    await pollInbox(fakeReader([[msg(1)]], "delta-1"));
    const failing: InboxReader = {
      async readChanges(_c, _s, onPage) {
        await onPage([msg(2)]);
        throw new Error("boom");
      },
    };
    await expect(pollInbox(failing)).rejects.toThrow("boom");
    const [s] = await db.query<{ delta_link: string }>("SELECT delta_link FROM mailbox_sync");
    expect(s.delta_link).toBe("delta-1");
    const r = await pollInbox(fakeReader([[msg(2), msg(3)]], "delta-2"));
    expect(r).toMatchObject({ stored: 1, duplicates: 1 });
  });

  it("restarts from the lookback window when the cursor expired", async () => {
    await pollInbox(fakeReader([[msg(1)]], "delta-1"));
    const calls: (string | null)[] = [];
    const expiring: InboxReader = {
      async readChanges(cursor, _s, onPage) {
        calls.push(cursor);
        if (cursor) throw new CursorExpiredError("gone");
        await onPage([msg(1), msg(2)]);
        return "delta-2";
      },
    };
    const r = await pollInbox(expiring);
    expect(calls).toEqual(["delta-1", null]);
    expect(r).toMatchObject({ cursorReset: true, stored: 1, duplicates: 1 });
  });

  it("dry run stores nothing and keeps no cursor", async () => {
    const seen: string[] = [];
    const r = await pollInbox(fakeReader([[msg(1)]]), { dryRun: true, onMessage: (m) => seen.push(m.subject) });
    expect(r.fetched).toBe(1);
    expect(seen).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM inbound_messages")).length).toBe(0);
    expect((await db.query("SELECT 1 FROM mailbox_sync")).length).toBe(0);
  });
});

describe("GraphInbox", () => {
  const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", mailbox: "testrequest@ftvcapital.com" };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function graph(pages: Response[]) {
    const urls: string[] = [];
    const prefer: (string | undefined)[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "tok", expires_in: 3600 });
      urls.push(url);
      prefer.push((init?.headers as Record<string, string>).Prefer);
      return pages.shift()!;
    }) as unknown as typeof fetch;
    return { inbox: new GraphInbox(cfg, fetchFn), urls, prefer };
  }

  const raw = (id: string, over = {}) => ({
    id,
    internetMessageId: `<${id}@x>`,
    conversationId: "c1",
    receivedDateTime: "2026-11-24T10:00:00Z",
    from: { emailAddress: { address: "Charitha@FTVCapital.com", name: "C" } },
    toRecipients: [{ emailAddress: { address: "testrequest@ftvcapital.com" } }],
    subject: "Re: [EN-2026-0004] x",
    body: { contentType: "html", content: "<p>hi</p>" },
    hasAttachments: true,
    ...over,
  });

  it("follows pages, skips removed items and drafts, requests immutable IDs", async () => {
    const { inbox, urls, prefer } = graph([
      json({ value: [raw("a"), { id: "b", "@removed": { reason: "deleted" } }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" }),
      json({ value: [raw("c", { isDraft: true }), raw("d")], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final" }),
    ]);
    const got: InboundMessage[] = [];
    const link = await inbox.readChanges(null, new Date("2026-11-20T00:00:00Z"), async (p) => void got.push(...p));
    expect(link).toBe("https://graph.microsoft.com/v1.0/delta-final");
    expect(got.map((m) => m.graphId)).toEqual(["a", "d"]);
    expect(got[0]).toMatchObject({ fromAddress: "charitha@ftvcapital.com", bodyType: "html", hasAttachments: true });
    expect(urls[0]).toContain("/mailFolders/inbox/messages/delta");
    expect(urls[0]).toContain("receivedDateTime");
    expect(prefer.every((p) => p?.includes('IdType="ImmutableId"'))).toBe(true);
  });

  it("maps a 410 to CursorExpiredError", async () => {
    const { inbox } = graph([json({ error: { code: "syncStateNotFound" } }, 410)]);
    await expect(inbox.readChanges("https://graph.microsoft.com/v1.0/old", new Date(), async () => {})).rejects.toBeInstanceOf(
      CursorExpiredError,
    );
  });

  it("refuses a paging link that points away from Graph", async () => {
    const { inbox } = graph([json({ value: [], "@odata.nextLink": "https://evil.example/steal" })]);
    await expect(inbox.readChanges(null, new Date(), async () => {})).rejects.toThrow(/non-Graph/);
  });
});
