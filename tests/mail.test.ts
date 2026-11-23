import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { GraphMailTransport } from "@/lib/mail/graph";
import { drainOutbox } from "@/lib/mail/sender";
import type { MailTransport } from "@/lib/mail/transport";
import { resetDb } from "./helpers";

const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", mailbox: "box@x.com" };

describe("GraphMailTransport", () => {
  it("gets a token, then posts sendMail to the shared mailbox", async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response(null, { status: 202 }),
    );
    const t = new GraphMailTransport(cfg, f as unknown as typeof fetch);
    await t.send({ to: "a@b.com", subject: "Hi", body: "Body" });
    await t.send({ to: "a@b.com", subject: "Hi2", body: "Body" });

    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.filter(([u]) => u.includes("oauth2")).length).toBe(1); // token cached
    const [url, init] = calls[1];
    expect(url).toBe("https://graph.microsoft.com/v1.0/users/box%40x.com/sendMail");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string).message.toRecipients[0].emailAddress.address).toBe("a@b.com");
  });

  it("throws on a non-202 response", async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        : new Response("denied", { status: 403 }),
    );
    const t = new GraphMailTransport(cfg, f as unknown as typeof fetch);
    await expect(t.send({ to: "a@b.com", subject: "s", body: "b" })).rejects.toThrow(/403/);
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
    expect(await drainOutbox(t)).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(sent).toEqual(["a@x.com"]);
    const [row] = await db.query<{ status: string; sent_at: string }>("SELECT status, sent_at FROM outbox");
    expect(row.status).toBe("Sent");
    expect(row.sent_at).toBeTruthy();
    expect(await drainOutbox(t)).toEqual({ sent: 0, failed: 0, retried: 0 }); // nothing sent twice
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
    expect(await drainOutbox(t)).toEqual({ sent: 0, failed: 0, retried: 1 });
    await drainOutbox(t);
    expect(await drainOutbox(t)).toEqual({ sent: 0, failed: 1, retried: 0 });
    const [row] = await db.query<{ status: string; attempts: number; last_error: string }>(
      "SELECT status, attempts, last_error FROM outbox",
    );
    expect(row).toMatchObject({ status: "Failed", attempts: 3, last_error: "boom" });
  });
});
