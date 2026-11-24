import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { GraphMailTransport } from "@/lib/mail/graph";
import { mailMode, sendPolicy } from "@/lib/mail";
import { sendProjectMail } from "@/lib/mail/trigger";
import { createProject } from "@/lib/projects";
import { drainOutbox, requeueFailed } from "@/lib/mail/sender";
import { MailError, type MailTransport } from "@/lib/mail/transport";
import { ALICE, person, resetDb, validBrief } from "./helpers";

const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", mailbox: "box@x.com" };

const tokenRes = () => new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));

/** Fake Graph: token endpoint and sendMail. The sendMail status can be overridden. */
function graph(o: { send?: number | (() => number); token?: () => Response } = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("oauth2")) return o.token ? o.token() : tokenRes();
    const status = typeof o.send === "function" ? o.send() : (o.send ?? 202);
    return new Response(status === 202 ? null : "x", { status });
  });
}
const urls = (f: ReturnType<typeof vi.fn>) =>
  (f.mock.calls as unknown as [string, RequestInit][]).map(([u, i]) => `${i?.method ?? "GET"} ${u}`);
const mail = { to: "a@b.com", subject: "s", body: "b" };

describe("GraphMailTransport", () => {
  it("gets a token, then posts sendMail to the shared mailbox", async () => {
    const f = graph();
    const t = new GraphMailTransport(cfg, f as unknown as typeof fetch);
    await t.send({ to: "a@b.com", subject: "Hi", body: "Body" });
    await t.send({ to: "a@b.com", subject: "Hi2", body: "Body" });

    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(urls(f).filter((u) => u.includes("oauth2")).length).toBe(1); // token cached
    const [url, init] = calls[1];
    expect(url).toBe("https://graph.microsoft.com/v1.0/users/box%40x.com/sendMail");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
    expect(JSON.parse(init.body as string).message.toRecipients[0].emailAddress.address).toBe("a@b.com");
  });

  it("throws on a non-202 response", async () => {
    const t = new GraphMailTransport(cfg, graph({ send: 403 }) as unknown as typeof fetch);
    await expect(t.send(mail)).rejects.toThrow(/403/);
  });
});

describe("GraphMailTransport resilience", () => {
  it("retries once with a fresh token after a 401", async () => {
    let n = 0;
    const f = graph({ send: () => (++n === 1 ? 401 : 202) });
    await new GraphMailTransport(cfg, f as unknown as typeof fetch).send(mail);
    expect(urls(f).filter((u) => u.includes("oauth2")).length).toBe(2);
  });

  it("classifies errors: 400 permanent; 403, 429, token failure and network errors run-level", async () => {
    const kind = (f: typeof fetch) =>
      new GraphMailTransport(cfg, f).send(mail).catch((e) => (e as MailError).kind);
    expect(await kind(graph({ send: 400 }) as unknown as typeof fetch)).toBe("permanent");
    expect(await kind(graph({ send: 403 }) as unknown as typeof fetch)).toBe("run");
    expect(await kind(graph({ send: 429 }) as unknown as typeof fetch)).toBe("run");
    expect(await kind((async () => new Response("bad", { status: 401 })) as typeof fetch)).toBe("run");
    expect(await kind((async () => Promise.reject(new Error("socket hang up"))) as typeof fetch)).toBe("run");
  });

  it("falls back to a default token lifetime when expires_in is missing", async () => {
    const f = graph({ token: () => new Response(JSON.stringify({ access_token: "tok" })) });
    const t = new GraphMailTransport(cfg, f as unknown as typeof fetch);
    await t.send(mail);
    await t.send(mail);
    expect(urls(f).filter((u) => u.includes("oauth2")).length).toBe(1);
  });
});

describe("mailMode", () => {
  it("defaults to log and rejects unknown values", () => {
    expect(mailMode({})).toBe("log");
    expect(mailMode({ MAIL_MODE: "graph" })).toBe("graph");
    expect(() => mailMode({ MAIL_MODE: "grpah" })).toThrow(/MAIL_MODE/);
  });
});

describe("drainOutbox", () => {
  beforeEach(resetDb);

  const queue = (recipient: string) =>
    db.query(
      "INSERT INTO outbox (kind, recipient, subject, body, created_at) VALUES ('t', $1, 'S', 'B', 'now')",
      [recipient],
    );

  it("sends queued mail and marks it Sent", async () => {
    await queue("a@x.com");
    const sent: string[] = [];
    const t: MailTransport = { send: async (m) => void sent.push(m.to) };
    expect(await drainOutbox(t)).toEqual({ sent: 1, failed: 0, retried: 0, blocked: 0, stuck: 0 });
    expect(sent).toEqual(["a@x.com"]);
    const [row] = await db.query<{ status: string; sent_at: string }>("SELECT status, sent_at FROM outbox");
    expect(row.status).toBe("Sent");
    expect(row.sent_at).toBeTruthy();
    expect(await drainOutbox(t)).toEqual({ sent: 0, failed: 0, retried: 0, blocked: 0, stuck: 0 }); // nothing sent twice
  });

  it("stores the thread ids returned by the transport", async () => {
    await queue("a@x.com");
    await drainOutbox({ send: async () => ({ conversationId: "conv-9", internetMessageId: "<z@x>" }) });
    const [row] = await db.query<{ conversation_id: string; internet_message_id: string }>(
      "SELECT conversation_id, internet_message_id FROM outbox",
    );
    expect(row).toEqual({ conversation_id: "conv-9", internet_message_id: "<z@x>" });
  });

  it("redirects every email when redirectTo is set", async () => {
    await queue("real@x.com");
    const got: { to: string; body: string }[] = [];
    await drainOutbox({ send: async (m) => void got.push(m) }, { redirectTo: "me@x.com" });
    expect(got[0].to).toBe("me@x.com");
    expect(got[0].body).toContain("real@x.com");
  });

  it("retries then marks Failed after 3 attempts", async () => {
    await queue("a@x.com");
    const t: MailTransport = { send: async () => Promise.reject(new Error("boom")) };
    expect(await drainOutbox(t)).toEqual({ sent: 0, failed: 0, retried: 1, blocked: 0, stuck: 0 });
    await drainOutbox(t);
    expect(await drainOutbox(t)).toEqual({ sent: 0, failed: 1, retried: 0, blocked: 0, stuck: 0 });
    const [row] = await db.query<{ status: string; attempts: number; last_error: string }>(
      "SELECT status, attempts, last_error FROM outbox",
    );
    expect(row).toMatchObject({ status: "Failed", attempts: 3, last_error: "boom" });
  });

  it("a run-level error stops the run, charges no attempts and leaves rows Queued", async () => {
    await queue("a@x.com");
    await queue("b@x.com");
    const t: MailTransport = { send: async () => Promise.reject(new MailError("auth down", "run")) };
    const r = await drainOutbox(t);
    expect(r).toMatchObject({ sent: 0, failed: 0, retried: 0, aborted: "auth down" });
    const rows = await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM outbox ORDER BY id");
    expect(rows).toEqual([
      { status: "Queued", attempts: 0 },
      { status: "Queued", attempts: 0 },
    ]);
  });

  it("a permanent error fails the message at once", async () => {
    await queue("bad");
    const t: MailTransport = { send: async () => Promise.reject(new MailError("invalid address", "permanent")) };
    expect(await drainOutbox(t)).toMatchObject({ failed: 1 });
    const [row] = await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM outbox");
    expect(row).toEqual({ status: "Failed", attempts: 1 });
  });

  it("never resends a message whose result could not be recorded", async () => {
    await queue("a@x.com");
    let sends = 0;
    const t: MailTransport = {
      send: async () => {
        sends++;
        // Simulate the database failing right after delivery.
        await db.query("ALTER TABLE outbox ADD CONSTRAINT t_nosent CHECK (status <> 'Sent')");
      },
    };
    try {
      await expect(drainOutbox(t)).rejects.toThrow();
    } finally {
      await db.query("ALTER TABLE outbox DROP CONSTRAINT t_nosent");
    }
    const again = await drainOutbox(t);
    expect(sends).toBe(1);
    expect(again.stuck).toBe(1);
    const [row] = await db.query<{ status: string }>("SELECT status FROM outbox");
    expect(row.status).toBe("Sending");
  });

  it("requeueFailed puts Failed rows back with a fresh attempt count", async () => {
    await queue("a@x.com");
    await drainOutbox({ send: async () => Promise.reject(new MailError("nope", "permanent")) });
    expect(await requeueFailed()).toBe(1);
    const [row] = await db.query<{ status: string; attempts: number }>("SELECT status, attempts FROM outbox");
    expect(row).toEqual({ status: "Queued", attempts: 0 });
  });

  it("blocks any recipient that is not on the allowlist and never sends it", async () => {
    await queue("vendor@external.com");
    await queue("Adas@ftvcapital.com");
    const sent: string[] = [];
    const r = await drainOutbox(
      { send: async (m) => void sent.push(m.to) },
      { allowedRecipients: ["adas@ftvcapital.com", "charitha@ftvcapital.com"] },
    );
    expect(r).toMatchObject({ sent: 1, blocked: 1 });
    expect(sent).toEqual(["Adas@ftvcapital.com"]);
    const rows = await db.query<{ recipient: string; status: string; attempts: number }>(
      "SELECT recipient, status, attempts FROM outbox ORDER BY id",
    );
    expect(rows).toEqual([
      { recipient: "vendor@external.com", status: "Blocked", attempts: 0 },
      { recipient: "Adas@ftvcapital.com", status: "Sent", attempts: 1 },
    ]);
    expect(await requeueFailed()).toBe(1); // Blocked rows can be released after the allowlist changes
  });

  it("limits a run to one project and keeps the vendor status in step", async () => {
    const a = await createProject(validBrief({ vendorIds: [1], teamUserIds: [] }), person(ALICE));
    const b = await createProject(validBrief({ vendorIds: [1], teamUserIds: [] }), person(ALICE));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const sent: string[] = [];
    const r = await drainOutbox({ send: async (m) => void sent.push(m.subject) }, { projectId: a.id });
    expect(r.sent).toBe(1);
    const status = async (id: number) =>
      (await db.query<{ status: string }>("SELECT status FROM project_vendors WHERE project_id=$1", [id]))[0].status;
    expect(await status(a.id)).toBe("Sent");
    expect(await status(b.id)).toBe("Pending send");
    await drainOutbox({ send: async () => Promise.reject(new MailError("bad", "permanent")) }, { projectId: b.id });
    expect(await status(b.id)).toBe("Send failed");
  });
});

describe("sendPolicy and the submit trigger", () => {
  it("refuses real sending outside production without an allowlist or redirect", () => {
    expect(() => sendPolicy({ MAIL_MODE: "graph" })).toThrow(/Refusing/);
    expect(sendPolicy({ MAIL_MODE: "graph", MAIL_ALLOWED_RECIPIENTS: " A@x.com, b@x.com " }).allowedRecipients).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(sendPolicy({ MAIL_MODE: "graph", MAIL_DEV_RECIPIENT: "Me@x.com" }).redirectTo).toBe("me@x.com");
    expect(() => sendPolicy({ MAIL_MODE: "graph", NODE_ENV: "production" })).not.toThrow();
    expect(() => sendPolicy({})).not.toThrow();
  });

  beforeEach(resetDb);

  it("does nothing in log mode, and never throws when sending is refused", async () => {
    const p = await createProject(validBrief({ vendorIds: [1], teamUserIds: [] }), person(ALICE));
    if (!p.ok) throw new Error("setup failed");
    expect(await sendProjectMail(p.id, {})).toMatchObject({ skipped: expect.any(String) });
    expect(await sendProjectMail(p.id, { MAIL_MODE: "graph" })).toMatchObject({ error: expect.stringMatching(/Refusing/) });
    const [row] = await db.query<{ status: string }>("SELECT status FROM outbox WHERE project_id=$1", [p.id]);
    expect(row.status).toBe("Queued");
  });
});
