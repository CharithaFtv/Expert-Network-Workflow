import { db } from "../db.ts";
import { CursorExpiredError, type InboundMessage, type InboxReader } from "./inbox.ts";
import { matchPending, type MatchCounts } from "./match.ts";
import { fetchAttachments, type AttachmentCounts, type AttachmentSource } from "./attachments.ts";
import { cleanPending, type CleanCounts } from "./clean.ts";
import { extractPending, type ExtractCounts } from "../ai/extract.ts";
import type { ModelClient } from "../ai/model.ts";

export const DEFAULT_LOOKBACK_DAYS = 14;

export type PollResult = {
  fetched: number;
  stored: number;
  duplicates: number;
  /** Graph IDs Postgres refused to store; each is kept in inbound_failures. */
  failed: string[];
  cursorReset?: boolean;
  /** What matching did with the messages waiting after this poll (not in a dry run). */
  matching?: MatchCounts;
  /** Attachment handling for verified mail (only for a reader that can list attachments). */
  attachments?: AttachmentCounts;
  /** Clean text and links produced for verified mail. */
  cleaning?: CleanCounts;
  /** What the model step did (only when extraction is on). */
  extraction?: ExtractCounts;
  /** Follow-up steps that failed after the messages were stored (the poll itself succeeded). */
  errors: string[];
};

/** Postgres text and JSONB cannot hold a NUL character; email can, so remove it before inserting. */
const noNul = (s: string) => s.replaceAll("\u0000", "");
/** JSONB rejects a lone surrogate escape, so swap any for U+FFFD before the payload is stored. */
const wellFormed = (s: string) =>
  s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");

/**
 * Keeps a message that could not be stored, with the error, so it is not lost when the cursor moves on.
 * If even this fails the error propagates: the poll stops and the cursor stays where it was.
 */
async function quarantine(m: InboundMessage, error: unknown) {
  const clean = stripNuls(m);
  await db.query(
    `INSERT INTO inbound_failures (graph_id, internet_message_id, error, payload, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (graph_id) DO UPDATE SET error = $3`,
    [
      clean.graphId,
      clean.internetMessageId && wellFormed(clean.internetMessageId),
      wellFormed(String((error as Error).message ?? error)).slice(0, 500),
      JSON.stringify(clean, (_k, v) => (typeof v === "string" ? wellFormed(v) : v)),
      new Date().toISOString(),
    ],
  );
}
function stripNuls(m: InboundMessage): InboundMessage {
  return {
    ...m,
    internetMessageId: m.internetMessageId && noNul(m.internetMessageId),
    conversationId: m.conversationId && noNul(m.conversationId),
    fromAddress: m.fromAddress && noNul(m.fromAddress),
    fromName: m.fromName && noNul(m.fromName),
    toAddresses: m.toAddresses.map(noNul),
    subject: noNul(m.subject),
    body: noNul(m.body),
    headers: m.headers && m.headers.map((h) => ({ name: noNul(h.name), value: noNul(h.value) })),
  };
}

/** Stores a message once. Either unique ID (Graph's or the RFC Message-ID) drops a duplicate. */
export async function storeInbound(m: InboundMessage): Promise<boolean> {
  m = stripNuls(m);
  const rows = await db.query(
    `INSERT INTO inbound_messages
       (graph_id, internet_message_id, conversation_id, received_at, from_address, from_name,
        to_addresses, subject, body_type, body, has_attachments, headers, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      m.graphId,
      m.internetMessageId,
      m.conversationId,
      m.receivedAt,
      m.fromAddress,
      m.fromName,
      m.toAddresses,
      m.subject,
      m.bodyType,
      m.body,
      m.hasAttachments,
      m.headers ? JSON.stringify(m.headers) : null,
      new Date().toISOString(),
    ],
  );
  return rows.length === 1;
}

/** Postgres data errors (SQLSTATE class 22) mean this one message cannot be stored, not that the database is down. */
const isDataError = (e: unknown) => String((e as { code?: unknown }).code ?? "").startsWith("22");

async function saveCursor(name: string, link: string, since: Date) {
  await db.query(
    `INSERT INTO mailbox_sync (name, delta_link, since, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (name) DO UPDATE SET delta_link = $2, since = $3, updated_at = $4`,
    [name, link, since.toISOString(), new Date().toISOString()],
  );
}

/**
 * One poll. After each page is stored the cursor moves to that page's paging link, so a crash or the
 * page cap loses at most one page of progress and the unique IDs drop the repeats. The final delta link
 * is saved last. An expired cursor restarts from the lookback window (`opts.since`, else the last 14 days).
 * A message Postgres refuses to store is saved in `inbound_failures` and reported in `failed`, so it
 * cannot block the mailbox and is not lost.
 * dryRun reads and counts but stores nothing and keeps the cursor where it was.
 */
export async function pollInbox(
  reader: InboxReader,
  opts: {
    since?: Date;
    dryRun?: boolean;
    onMessage?: (m: InboundMessage) => void;
    /** The language model for step 3e. Null or absent: extraction is off and messages simply wait. */
    extractor?: ModelClient | null;
  } = {},
): Promise<PollResult> {
  const [state] = await db.query<{ delta_link: string | null; since: string | null }>(
    "SELECT delta_link, since FROM mailbox_sync WHERE name = $1",
    [reader.name],
  );
  const lookback = () => opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  // `since` only applies when reading from scratch; once a cursor exists it is kept as it was.
  let cursor = state?.delta_link ?? null;
  let since = cursor && state?.since ? new Date(state.since) : lookback();

  const result: PollResult = { fetched: 0, stored: 0, duplicates: 0, failed: [], errors: [] };
  const onPage = async (messages: InboundMessage[], checkpoint: string | null) => {
    for (const m of messages) {
      result.fetched++;
      opts.onMessage?.(m);
      if (opts.dryRun) continue;
      try {
        if (await storeInbound(m)) result.stored++;
        else result.duplicates++;
      } catch (e) {
        if (!isDataError(e)) throw e;
        await quarantine(m, e); // saved before the cursor can move past it
        result.failed.push(m.graphId);
      }
    }
    if (checkpoint && !opts.dryRun) await saveCursor(reader.name, checkpoint, since);
  };

  let next: string;
  try {
    next = await reader.readChanges(cursor, since, onPage);
  } catch (e) {
    if (!(e instanceof CursorExpiredError)) throw e;
    result.cursorReset = true;
    cursor = null;
    since = lookback();
    next = await reader.readChanges(null, since, onPage);
  }

  if (!opts.dryRun) {
    await saveCursor(reader.name, next, since);
    // After the cursor is safe, two follow-up steps. Each failure is recorded in `errors` instead of being
    // thrown, so the result still says what was stored and one failing step does not stop the other.
    // Unmatched messages stay in `Received` and the next poll (or `npm run match-inbox`) tries again.
    try {
      result.matching = await matchPending();
    } catch (e) {
      result.errors.push(`matching: ${(e as Error).message}`);
    }
    // Attachments of verified mail only; a failed message is retried on a later poll.
    if ("listAttachments" in reader) {
      try {
        result.attachments = await fetchAttachments(reader as unknown as AttachmentSource);
      } catch (e) {
        result.errors.push(`attachments: ${(e as Error).message}`);
      }
    }
    // The clean text and links of verified mail (needs no network, so every poll can do it).
    try {
      result.cleaning = await cleanPending();
    } catch (e) {
      result.errors.push(`cleaning: ${(e as Error).message}`);
    }
    // The model step, last and optional: a failure here never undoes or blocks anything above it.
    if (opts.extractor) {
      try {
        result.extraction = await extractPending(opts.extractor);
      } catch (e) {
        result.errors.push(`extraction: ${(e as Error).message}`);
      }
    }
  }
  return result;
}
