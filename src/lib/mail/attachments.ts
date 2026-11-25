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
  /** Reads at most `maxBytes`; throws AttachmentTooLargeError (and stops reading) if the file is larger. */
  downloadAttachment(graphId: string, attachmentId: string, maxBytes?: number): Promise<Buffer>;
}

/** The file turned out larger than the limit. Not a failure: the attachment is recorded as Skipped. */
export class AttachmentTooLargeError extends Error {}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** Programs, scripts, installers, shortcuts and macro-enabled Office files: recorded, never stored. */
const BLOCKED = new Set([
  "exe", "dll", "com", "scr", "msi", "msp", "mst", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "vb", "js",
  "jse", "wsf", "ws", "wsh", "wsc", "jar", "jnlp", "lnk", "hta", "cpl", "scf", "inf", "reg", "pif", "chm", "msc",
  "sys", "ocx", "drv", "gadget", "application", "appx", "msix", "appxbundle", "msixbundle", "sh", "bash", "zsh",
  "csh", "py", "pl", "rb", "app", "pkg", "deb", "rpm", "bin", "ipa", "apk", "iso", "dmg", "docm", "xlsm", "pptm",
  "dotm", "xltm", "xlam", "ppam", "ppsm", "potm", "sldm", "xla", "iqy", "slk",
]);

/** Control and bidirectional-override characters can hide a real extension; trailing dots and spaces are ignored by Windows. */
const normalizedName = (name: string) =>
  name.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "").replace(/[.\s]+$/, "");

const extension = (name: string) => {
  const n = normalizedName(name);
  return n.includes(".") ? n.split(".").pop()!.trim().toLowerCase() : "";
};

/** Why this attachment should not be stored, or null if it can be. */
export function skipReason(a: AttachmentInfo, storedBytes: number): string | null {
  if (a.kind !== "file") return "not a file attachment";
  if (a.isInline) return "inline image";
  if (BLOCKED.has(extension(a.name))) return "blocked file type";
  if (a.size > MAX_ATTACHMENT_BYTES) return "over the size limit";
  if (storedBytes + a.size > MAX_MESSAGE_BYTES) return "message size limit reached";
  return null;
}

const cleanName = (s: string) => normalizedName(s).slice(0, 255) || "unnamed";

/** After this many failed runs a message is left alone and reported, so it cannot block newer ones. */
export const MAX_ATTACHMENT_TRIES = 5;

type Prepared = { info: AttachmentInfo; reason: string | null; bytes: Buffer | null };

export type AttachmentCounts = {
  messages: number;
  stored: number;
  skipped: number;
  failed: number;
  /** The first few failure reasons, for the operator. */
  errors: string[];
  /** Messages given up on after MAX_ATTACHMENT_TRIES failed runs; they need a person. */
  abandoned: number;
};

/**
 * Handles every Matched message that has attachments and has not been done yet. One message at a time,
 * all its rows written together; a failure leaves that message for the next run.
 */
export async function fetchAttachments(source: AttachmentSource, limit = 50): Promise<AttachmentCounts> {
  const counts: AttachmentCounts = { messages: 0, stored: 0, skipped: 0, failed: 0, errors: [], abandoned: 0 };
  // Fewest failures first, so a message that keeps failing cannot hold up the ones behind it.
  const rows = await db.query<{ id: number; graph_id: string }>(
    `SELECT id, graph_id FROM inbound_messages
     WHERE status = 'Matched' AND has_attachments AND attachments_fetched_at IS NULL AND purged_at IS NULL
       AND attachments_attempts < $2
     ORDER BY attachments_attempts, id LIMIT $1`,
    [limit, MAX_ATTACHMENT_TRIES],
  );
  for (const m of rows) {
    try {
      const prepared: Prepared[] = [];
      let storedBytes = 0;
      for (const info of await source.listAttachments(m.graph_id)) {
        let reason = skipReason(info, storedBytes);
        let bytes: Buffer | null = null;
        if (!reason) {
          try {
            // The source stops reading at the limit, so a file larger than Graph listed is never held whole.
            bytes = await source.downloadAttachment(m.graph_id, info.id, MAX_ATTACHMENT_BYTES);
          } catch (e) {
            if (!(e instanceof AttachmentTooLargeError)) throw e;
            bytes = null;
            reason = "over the size limit"; // a finding about the file, not a failed download
          }
        }
        if (!reason && bytes) {
          // The size Graph listed can be wrong; the bytes we got are what counts.
          if (bytes.length > MAX_ATTACHMENT_BYTES) {
            reason = "over the size limit";
            bytes = null;
          } else if (storedBytes + bytes.length > MAX_MESSAGE_BYTES) {
            reason = "message size limit reached";
            bytes = null;
          } else storedBytes += bytes.length;
        }
        prepared.push({ info, reason, bytes });
      }
      const now = new Date().toISOString();
      const written = await tx(async (q) => {
        // The download happened outside this transaction, so check the message again under a lock: a purge,
        // a re-assignment or another run may have changed it meanwhile. If so, write nothing.
        const [cur] = await q.query<{ status: string; purged_at: string | null; done: string | null }>(
          "SELECT status, purged_at, attachments_fetched_at AS done FROM inbound_messages WHERE id = $1 FOR UPDATE",
          [m.id],
        );
        if (!cur || cur.status !== "Matched" || cur.purged_at || cur.done) return false;
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
        return true;
      });
      if (!written) continue; // changed under us: nothing written, nothing counted
      counts.messages++;
      for (const p of prepared) p.bytes ? counts.stored++ : counts.skipped++;
    } catch (e) {
      counts.failed++; // retried on a later run, until MAX_ATTACHMENT_TRIES
      const reason = (e as Error).message;
      if (counts.errors.length < 3) counts.errors.push(`message ${m.id}: ${reason}`);
      await db
        .query("UPDATE inbound_messages SET attachments_attempts = attachments_attempts + 1, attachments_error = $2 WHERE id = $1", [
          m.id,
          reason.slice(0, 500),
        ])
        .catch(() => {}); // recording the failure must not hide the real one
    }
  }
  const [gone] = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM inbound_messages
     WHERE status = 'Matched' AND has_attachments AND attachments_fetched_at IS NULL AND purged_at IS NULL
       AND attachments_attempts >= $1`,
    [MAX_ATTACHMENT_TRIES],
  );
  counts.abandoned = gone.n;
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
