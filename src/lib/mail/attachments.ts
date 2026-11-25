import { createHash } from "node:crypto";
import { db, tx } from "../db.ts";

/**
 * Step 3c: keep the attachments of verified mail, small and inert.
 *
 * Only Matched messages are looked at. Each attachment is either Stored (bytes in Postgres) or
 * Skipped with a reason. Nothing is opened, converted or executed here; text extraction is a later step
 * and only when a real attachment needs it.
 */
export type AttachmentInfo = {
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  isInline: boolean;
  kind: "file" | "item" | "reference";
};

/** Where attachments come from. Graph in production, a fake in tests. */
export interface AttachmentSource {
  listAttachments(graphId: string): Promise<AttachmentInfo[]>;
  downloadAttachment(graphId: string, attachmentId: string): Promise<Buffer>;
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** Programs, scripts, installers and macro-enabled Office files: recorded, never stored. */
const BLOCKED = new Set([
  "exe", "dll", "com", "scr", "msi", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "jar", "lnk", "hta",
  "docm", "xlsm", "pptm", "dotm", "xltm", "xlam", "iso", "dmg", "apk",
]);

const extension = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

/** Why this attachment should not be stored, or null if it can be. */
export function skipReason(a: AttachmentInfo, storedBytes: number): string | null {
  if (a.kind !== "file") return "not a file attachment";
  if (a.isInline) return "inline image";
  if (BLOCKED.has(extension(a.name))) return "blocked file type";
  if (a.size > MAX_ATTACHMENT_BYTES) return "over the size limit";
  if (storedBytes + a.size > MAX_MESSAGE_BYTES) return "message size limit reached";
  return null;
}

const cleanName = (s: string) => s.replaceAll("\u0000", "").slice(0, 255) || "unnamed";

type Prepared = { info: AttachmentInfo; reason: string | null; bytes: Buffer | null };

export type AttachmentCounts = {
  messages: number;
  stored: number;
  skipped: number;
  failed: number;
  /** The first few failure reasons, for the operator. */
  errors: string[];
};

/**
 * Handles every Matched message that has attachments and has not been done yet. One message at a time,
 * all its rows written together; a failure leaves that message for the next run.
 */
export async function fetchAttachments(source: AttachmentSource, limit = 50): Promise<AttachmentCounts> {
  const counts: AttachmentCounts = { messages: 0, stored: 0, skipped: 0, failed: 0, errors: [] };
  const rows = await db.query<{ id: number; graph_id: string }>(
    `SELECT id, graph_id FROM inbound_messages
     WHERE status = 'Matched' AND has_attachments AND attachments_fetched_at IS NULL AND purged_at IS NULL
     ORDER BY id LIMIT $1`,
    [limit],
  );
  for (const m of rows) {
    try {
      const prepared: Prepared[] = [];
      let storedBytes = 0;
      for (const info of await source.listAttachments(m.graph_id)) {
        let reason = skipReason(info, storedBytes);
        let bytes: Buffer | null = null;
        if (!reason) {
          bytes = await source.downloadAttachment(m.graph_id, info.id);
          // The size Graph listed can be wrong; the bytes we got are what counts.
          if (bytes.length > MAX_ATTACHMENT_BYTES) {
            reason = "over the size limit";
            bytes = null;
          } else storedBytes += bytes.length;
        }
        prepared.push({ info, reason, bytes });
      }
      const now = new Date().toISOString();
      await tx(async (q) => {
        for (const { info, reason, bytes } of prepared) {
          await q.query(
            `INSERT INTO inbound_attachments
               (message_id, graph_attachment_id, name, content_type, size_bytes, status, skip_reason, sha256, content, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (message_id, graph_attachment_id) DO NOTHING`,
            [
              m.id,
              info.id,
              cleanName(info.name),
              info.contentType,
              bytes ? bytes.length : info.size,
              bytes ? "Stored" : "Skipped",
              reason,
              bytes ? createHash("sha256").update(bytes).digest("hex") : null,
              bytes,
              now,
            ],
          );
        }
        await q.query("UPDATE inbound_messages SET attachments_fetched_at = $2 WHERE id = $1", [m.id, now]);
      });
      counts.messages++;
      for (const p of prepared) p.bytes ? counts.stored++ : counts.skipped++;
    } catch (e) {
      counts.failed++; // left for the next run
      if (counts.errors.length < 3) counts.errors.push(`message ${m.id}: ${(e as Error).message}`);
    }
  }
  return counts;
}

/**
 * Removes the content of messages whose retention date has passed: body, headers and attachment bytes.
 * The row stays (ids, status, match result) so history is still traceable. Messages with no
 * retain_until are never touched, and nothing sets retain_until yet.
 */
export async function purgeExpired(now = new Date()): Promise<number> {
  const stamp = now.toISOString();
  return tx(async (q) => {
    const rows = await q.query<{ id: number }>(
      `UPDATE inbound_messages SET body = '', headers = NULL, purged_at = $1
       WHERE retain_until IS NOT NULL AND retain_until <= $1 AND purged_at IS NULL RETURNING id`,
      [stamp],
    );
    if (rows.length) {
      await q.query(
        `UPDATE inbound_attachments SET content = NULL, status = 'Purged'
         WHERE message_id = ANY($1) AND status = 'Stored'`,
        [rows.map((r) => r.id)],
      );
    }
    return rows.length;
  });
}
