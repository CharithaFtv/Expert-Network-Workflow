import { beforeEach, describe, expect, it, vi } from "vitest";
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
    name: "test/inbox",
    calls,
    async readChanges(cursor, _since, onPage) {
      calls.push(cursor);
      for (const p of pages) await onPage(p, null);
      return link;
    },
  };
}

beforeEach(resetDb);

describe("pollInbox", () => {
  it("stores messages and saves the cursor", async () => {
    const r = await pollInbox(fakeReader([[msg(1), msg(2)], [msg(3)]]));
    expect(r).toEqual({ fetched: 3, stored: 3, duplicates: 0, failed: [] });
    const [s] = await db.query<{ delta_link: string }>("SELECT delta_link FROM mailbox_sync");
    expect(s.delta_link).toBe("delta-1");
  });

  it("keeps a separate cursor for each mailbox", async () => {
    await pollInbox({ ...fakeReader([[msg(1)]], "delta-A"), name: "a@x.com/inbox" });
    const other = { ...fakeReader([[msg(2)]], "delta-B"), name: "b@x.com/inbox" };
    await pollInbox(other);
    expect(other.calls).toEqual([null]); // started fresh instead of reusing the cursor of mailbox A
    const rows = await db.query<{ name: string }>("SELECT name FROM mailbox_sync ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["a@x.com/inbox", "b@x.com/inbox"]);
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
      name: "test/inbox",
      async readChanges(_c, _s, onPage) {
        await onPage([msg(2)], null);
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
      name: "test/inbox",
      async readChanges(cursor, _s, onPage) {
        calls.push(cursor);
        if (cursor) throw new CursorExpiredError("gone");
        await onPage([msg(1), msg(2)], null);
        return "delta-2";
      },
    };
    const r = await pollInbox(expiring);
    expect(calls).toEqual(["delta-1", null]);
    expect(r).toMatchObject({ cursorReset: true, stored: 1, duplicates: 1 });
  });

  it("stores a message that contains NUL characters", async () => {
    const r = await pollInbox(
      fakeReader([[msg(1, { body: "a\u0000b", subject: "x\u0000y", headers: [{ name: "H", value: "v\u0000" }] })]]),
    );
    expect(r).toMatchObject({ stored: 1, failed: [] });
    const [row] = await db.query<{ body: string; subject: string }>("SELECT body, subject FROM inbound_messages");
    expect(row).toEqual({ body: "ab", subject: "xy" });
  });

  it("skips a message Postgres refuses with a data error and still advances the cursor", async () => {
    const real = db.query.bind(db);
    const spy = vi.spyOn(db, "query").mockImplementation(async (text: string, params?: unknown[]) => {
      if (text.includes("INSERT INTO inbound_messages") && params?.[0] === "g2") {
        throw Object.assign(new Error("invalid byte sequence"), { code: "22021" });
      }
      return real(text, params);
    });
    try {
      const r = await pollInbox(fakeReader([[msg(1), msg(2), msg(3)]], "delta-ok"));
      expect(r).toMatchObject({ fetched: 3, stored: 2, failed: ["g2"] });
    } finally {
      spy.mockRestore();
    }
    const [q] = await db.query<{ graph_id: string; error: string; payload: { subject: string } }>(
      "SELECT graph_id, error, payload FROM inbound_failures",
    );
    expect(q).toMatchObject({ graph_id: "g2", error: "invalid byte sequence" });
    expect(q.payload.subject).toContain("ask 2");
    const [s] = await db.query<{ delta_link: string }>("SELECT delta_link FROM mailbox_sync");
    expect(s.delta_link).toBe("delta-ok");
  });

  it("stops without moving the cursor when a refused message cannot be quarantined either", async () => {
    await pollInbox(fakeReader([[msg(1)]], "delta-1"));
    const real = db.query.bind(db);
    const spy = vi.spyOn(db, "query").mockImplementation(async (text: string, params?: unknown[]) => {
      if (text.includes("INSERT INTO inbound_messages")) throw Object.assign(new Error("bad"), { code: "22021" });
      if (text.includes("INSERT INTO inbound_failures")) throw new Error("db down");
      return real(text, params);
    });
    try {
      await expect(pollInbox(fakeReader([[msg(2)]], "delta-2"))).rejects.toThrow("db down");
    } finally {
      spy.mockRestore();
    }
    const [s] = await db.query<{ delta_link: string }>("SELECT delta_link FROM mailbox_sync");
    expect(s.delta_link).toBe("delta-1");
  });

  it("does not hide a database outage as a bad message", async () => {
    const failing: InboxReader = {
      name: "test/inbox",
      async readChanges(_c, _s, onPage) {
        await db.query("SELECT 1");
        await onPage([{ ...msg(1), receivedAt: undefined as unknown as string }], null); // NOT NULL violation (class 23)
        return "x";
      },
    };
    await expect(pollInbox(failing)).rejects.toThrow();
  });

  it("saves a checkpoint after every page so a capped run resumes instead of restarting", async () => {
    const pages: [InboundMessage[], string | null][] = [[[msg(1)], "next-1"], [[msg(2)], "next-2"]];
    const capped: InboxReader = {
      name: "test/inbox",
      async readChanges(_c, _s, onPage) {
        for (const [m, cp] of pages) await onPage(m, cp);
        throw new Error("exceeded page cap");
      },
    };
    await expect(pollInbox(capped)).rejects.toThrow("page cap");
    const [s] = await db.query<{ delta_link: string }>("SELECT delta_link FROM mailbox_sync");
    expect(s.delta_link).toBe("next-2");
    const resumed = fakeReader([[msg(3)]], "delta-done");
    await pollInbox(resumed);
    expect(resumed.calls).toEqual(["next-2"]);
  });

  it("an expired cursor restarts from the last 14 days, not the old saved start", async () => {
    await pollInbox(fakeReader([[msg(1)]], "delta-1"), { since: new Date("2025-01-01T00:00:00Z") });
    const seen: Date[] = [];
    const expiring: InboxReader = {
      name: "test/inbox",
      async readChanges(cursor, since) {
        seen.push(since);
        if (cursor) throw new CursorExpiredError("gone");
        return "delta-2";
      },
    };
    await pollInbox(expiring);
    expect(seen[0].toISOString()).toBe("2025-01-01T00:00:00.000Z"); // normal poll keeps the saved start
    const ageDays = (Date.now() - seen[1].getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(13.9);
    expect(ageDays).toBeLessThan(14.1);
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
      prefer.push(new Headers(init?.headers).get("Prefer") ?? undefined);
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
    expect(urls[0]).not.toContain("$filter"); // a filtered delta query is capped at 5,000 messages
    expect(prefer.every((p) => p?.includes('IdType="ImmutableId"'))).toBe(true);
  });

  it("drops messages received before the lookback instead of filtering in the query", async () => {
    const { inbox } = graph([
      json({
        value: [raw("old", { receivedDateTime: "2026-11-01T00:00:00Z" }), raw("new")],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/d",
      }),
    ]);
    const got: InboundMessage[] = [];
    await inbox.readChanges(null, new Date("2026-11-20T00:00:00Z"), async (p) => void got.push(...p));
    expect(got.map((m) => m.graphId)).toEqual(["new"]);
  });

  it("names its cursor after the mailbox and folder", () => {
    expect(graph([]).inbox.name).toBe("testrequest@ftvcapital.com/inbox");
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
