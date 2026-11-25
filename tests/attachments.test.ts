import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  fetchAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TRIES,
  MAX_MESSAGE_BYTES,
  purgeExpired,
  skipReason,
  type AttachmentInfo,
  type AttachmentSource,
} from "@/lib/mail/attachments";
import { GraphInbox } from "@/lib/mail/inbox";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const info = (over: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
  id: "a1",
  name: "profile.pdf",
  contentType: "application/pdf",
  size: 1000,
  isInline: false,
  kind: "file",
  ...over,
});

let n = 0;
async function message(status = "Matched", hasAttachments = true) {
  n++;
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages (graph_id, received_at, subject, body, headers, status, has_attachments, created_at)
     VALUES ($1, $2, 's', 'body text', '[{"name":"X","value":"y"}]', $3, $4, $5) RETURNING id`,
    [`g${n}`, new Date().toISOString(), status, hasAttachments, new Date().toISOString()],
  );
  return { id: row.id, graphId: `g${n}` };
}

/** A source that serves canned attachments and records downloads. */
function source(byMessage: Record<string, { info: AttachmentInfo; bytes: Buffer }[]>) {
  const downloads: string[] = [];
  const s: AttachmentSource & { downloads: string[]; failOn?: string } = {
    downloads,
    async listAttachments(graphId) {
      return (byMessage[graphId] ?? []).map((a) => a.info);
    },
    async downloadAttachment(graphId, id) {
      if (s.failOn === id) throw new Error("download failed");
      downloads.push(id);
      return byMessage[graphId].find((a) => a.info.id === id)!.bytes;
    },
  };
  return s;
}

describe("skipReason", () => {
  it("accepts a small file", () => expect(skipReason(info(), 0)).toBeNull());
  it("skips programs, scripts and macro-enabled Office files", () => {
    for (const name of ["a.exe", "a.js", "A.DOCM", "b.xlsm", "c.ps1", "d.lnk"]) {
      expect(skipReason(info({ name }), 0)).toBe("blocked file type");
    }
  });
  it("sees through trailing dots and spaces, hidden characters and upper case", () => {
    for (const name of ["payload.exe.", "invoice.exe ", "invoice.exe. .", "a.EXE", "a.exe‮", "a.e​xe", "x.sh", "x.reg", "x.PIF"]) {
      expect(skipReason(info({ name }), 0), name).toBe("blocked file type");
    }
    for (const name of ["cv.pdf", "notes", "report.exe.pdf", "data.xlsx"]) {
      expect(skipReason(info({ name }), 0), name).toBeNull();
    }
  });
  it("skips inline images and non-file attachments", () => {
    expect(skipReason(info({ isInline: true }), 0)).toBe("inline image");
    expect(skipReason(info({ kind: "item" }), 0)).toBe("not a file attachment");
    expect(skipReason(info({ kind: "reference" }), 0)).toBe("not a file attachment");
  });
  it("enforces the size limits", () => {
    expect(skipReason(info({ size: MAX_ATTACHMENT_BYTES + 1 }), 0)).toBe("over the size limit");
    expect(skipReason(info({ size: 1000 }), MAX_MESSAGE_BYTES)).toBe("message size limit reached");
  });
});

describe("fetchAttachments", () => {
  it("stores a file with its hash, and records what it skipped without downloading it", async () => {
    const m = await message();
    const pdf = Buffer.from("%PDF-1.4 hello");
    const src = source({
      [m.graphId]: [
        { info: info({ id: "ok", name: "cv.pdf" }), bytes: pdf },
        { info: info({ id: "bad", name: "run.exe" }), bytes: Buffer.from("MZ") },
        { info: info({ id: "logo", name: "logo.png", isInline: true }), bytes: Buffer.from("png") },
      ],
    });
    const c = await fetchAttachments(src);
    expect(c).toMatchObject({ messages: 1, stored: 1, skipped: 2, failed: 0 });
    expect(src.downloads).toEqual(["ok"]); // the skipped ones were never downloaded
    const rows = await db.query<{ name: string; status: string; skip_reason: string | null; sha256: string | null; size_bytes: number }>(
      "SELECT name, status, skip_reason, sha256, size_bytes FROM inbound_attachments ORDER BY id",
    );
    expect(rows.map((r) => [r.name, r.status, r.skip_reason])).toEqual([
      ["cv.pdf", "Stored", null],
      ["run.exe", "Skipped", "blocked file type"],
      ["logo.png", "Skipped", "inline image"],
    ]);
    expect(rows[0].size_bytes).toBe(pdf.length);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const [stored] = await db.query<{ content: Buffer }>("SELECT content FROM inbound_attachments WHERE name = 'cv.pdf'");
    expect(stored.content.equals(pdf)).toBe(true);
  });

  it("only looks at verified, matched messages", async () => {
    const un = await message("Unverified");
    const no = await message("Unmatched");
    const src = source({
      [un.graphId]: [{ info: info(), bytes: Buffer.from("x") }],
      [no.graphId]: [{ info: info(), bytes: Buffer.from("x") }],
    });
    expect(await fetchAttachments(src)).toMatchObject({ messages: 0 });
    expect(src.downloads).toEqual([]);
  });

  it("does nothing for a message without attachments, and nothing twice", async () => {
    await message("Matched", false);
    const m = await message();
    const src = source({ [m.graphId]: [{ info: info(), bytes: Buffer.from("x") }] });
    expect(await fetchAttachments(src)).toMatchObject({ messages: 1, stored: 1 });
    expect(await fetchAttachments(src)).toMatchObject({ messages: 0, stored: 0 });
    expect(src.downloads).toHaveLength(1);
  });

  it("leaves a message for the next run when a download fails, and records why", async () => {
    const m = await message();
    const src = source({ [m.graphId]: [{ info: info({ id: "a1" }), bytes: Buffer.from("x") }] });
    src.failOn = "a1";
    const first = await fetchAttachments(src);
    expect(first).toMatchObject({ messages: 0, failed: 1 });
    expect(first.errors[0]).toContain("download failed");
    expect((await db.query("SELECT 1 FROM inbound_attachments")).length).toBe(0);
    src.failOn = undefined;
    expect(await fetchAttachments(src)).toMatchObject({ messages: 1, stored: 1, failed: 0 });
  });

  it("counts failed runs, gives up on a message after a few, and does not let it hold up newer ones", async () => {
    const bad1 = await message();
    const bad2 = await message();
    const bad3 = await message();
    const good = await message();
    const att = (graphId: string) => ({ [graphId]: [{ info: info({ id: "a1" }), bytes: Buffer.from("x") }] });
    const src = source({ ...att(bad1.graphId), ...att(bad2.graphId), ...att(bad3.graphId), ...att(good.graphId) });
    const realList = src.listAttachments;
    const failing = new Set([bad1.graphId, bad2.graphId, bad3.graphId]);
    src.listAttachments = async (graphId) => {
      if (failing.has(graphId)) throw new Error("not found");
      return realList(graphId);
    };

    // Two messages a run: the failing ones go first, but a failed message drops behind the untried ones.
    await fetchAttachments(src, 2);
    await fetchAttachments(src, 2);
    const [g] = await db.query<{ attachments_fetched_at: string | null }>(
      "SELECT attachments_fetched_at FROM inbound_messages WHERE id = $1",
      [good.id],
    );
    expect(g.attachments_fetched_at).not.toBeNull(); // reached on the second run

    let last = await fetchAttachments(src, 2);
    for (let i = 0; i < 10; i++) last = await fetchAttachments(src, 2);
    const rows = await db.query<{ attachments_attempts: number; attachments_error: string | null }>(
      "SELECT attachments_attempts, attachments_error FROM inbound_messages WHERE id = ANY($1) ORDER BY id",
      [[bad1.id, bad2.id, bad3.id]],
    );
    expect(rows.every((r) => r.attachments_attempts === MAX_ATTACHMENT_TRIES)).toBe(true);
    expect(rows[0].attachments_error).toContain("not found");
    expect(last).toMatchObject({ messages: 0, failed: 0, abandoned: 3 }); // given up on, and reported
  });

  it("trusts the bytes it received over the size Graph listed", async () => {
    const m = await message();
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    const src = source({ [m.graphId]: [{ info: info({ size: 10 }), bytes: big }] });
    expect(await fetchAttachments(src)).toMatchObject({ stored: 0, skipped: 1 });
    const [r] = await db.query<{ skip_reason: string; content: Buffer | null }>(
      "SELECT skip_reason, content FROM inbound_attachments",
    );
    expect(r).toEqual({ skip_reason: "over the size limit", content: null });
  });

  it("stops storing once a message reaches its total size", async () => {
    const m = await message();
    const chunk = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    const atts = [1, 2, 3, 4].map((i) => ({ info: info({ id: `a${i}`, name: `f${i}.pdf`, size: chunk.length }), bytes: chunk }));
    const src = source({ [m.graphId]: atts });
    expect(await fetchAttachments(src)).toMatchObject({ stored: 2, skipped: 2 });
  });

  it("removes NUL characters from a file name", async () => {
    const m = await message();
    const src = source({ [m.graphId]: [{ info: info({ name: "a\u0000b.pdf" }), bytes: Buffer.from("x") }] });
    await fetchAttachments(src);
    const [r] = await db.query<{ name: string }>("SELECT name FROM inbound_attachments");
    expect(r.name).toBe("ab.pdf");
  });
});

describe("purgeExpired", () => {
  it("clears the content of expired messages but keeps the row, and never touches the rest", async () => {
    const old = await message();
    const fresh = await message();
    const none = await message();
    const src = source({
      [old.graphId]: [{ info: info(), bytes: Buffer.from("x") }],
      [fresh.graphId]: [{ info: info(), bytes: Buffer.from("y") }],
    });
    await fetchAttachments(src);
    await db.query("UPDATE inbound_messages SET retain_until = $2 WHERE id = $1", [old.id, "2026-01-01T00:00:00Z"]);
    await db.query("UPDATE inbound_messages SET retain_until = $2 WHERE id = $1", [fresh.id, "2999-01-01T00:00:00Z"]);
    expect(await purgeExpired(new Date("2026-06-01T00:00:00Z"))).toBe(1);
    const rows = await db.query<{ id: number; body: string; headers: unknown; purged_at: string | null }>(
      "SELECT id, body, headers, purged_at FROM inbound_messages ORDER BY id",
    );
    const by = (id: number) => rows.find((r) => r.id === id)!;
    expect(by(old.id)).toMatchObject({ body: "", headers: null });
    expect(by(old.id).purged_at).not.toBeNull();
    expect(by(fresh.id)).toMatchObject({ body: "body text", purged_at: null });
    expect(by(none.id)).toMatchObject({ body: "body text", purged_at: null }); // no retain_until: kept
    const att = await db.query<{ message_id: number; status: string; content: Buffer | null }>(
      "SELECT message_id, status, content FROM inbound_attachments ORDER BY message_id",
    );
    expect(att.find((a) => a.message_id === old.id)).toMatchObject({ status: "Purged", content: null });
    expect(att.find((a) => a.message_id === fresh.id)?.status).toBe("Stored");
    expect(await purgeExpired(new Date("2026-06-01T00:00:00Z"))).toBe(0); // already done
  });
});

describe("GraphInbox attachments", () => {
  const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", mailbox: "testrequest@ftvcapital.com" };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("lists attachments with their kind and downloads bytes", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      if (url.includes("login.microsoftonline.com")) return json({ access_token: "tok", expires_in: 3600 });
      urls.push(url);
      if (url.endsWith("/$value")) return new Response(Buffer.from("hello"), { status: 200 });
      return json({
        value: [
          { id: "f", name: "cv.pdf", contentType: "application/pdf", size: 5, isInline: false, "@odata.type": "#microsoft.graph.fileAttachment" },
          { id: "i", name: "fwd", size: 9, "@odata.type": "#microsoft.graph.itemAttachment" },
          { id: "r", name: "link", size: 1, "@odata.type": "#microsoft.graph.referenceAttachment" },
        ],
      });
    }) as unknown as typeof fetch;
    const g = new GraphInbox(cfg, fetchFn);
    const list = await g.listAttachments("msg/1");
    expect(list.map((a) => [a.id, a.kind])).toEqual([["f", "file"], ["i", "item"], ["r", "reference"]]);
    expect((await g.downloadAttachment("msg/1", "f")).toString()).toBe("hello");
    expect(urls[0]).toContain("/messages/msg%2F1/attachments");
    expect(urls[1]).toContain("/attachments/f/$value");
  });
});
