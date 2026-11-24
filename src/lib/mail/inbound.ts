import { db } from "../db.ts";
import { CursorExpiredError, type InboundMessage, type InboxReader } from "./inbox.ts";

const FOLDER = "inbox";
export const DEFAULT_LOOKBACK_DAYS = 14;

export type PollResult = { fetched: number; stored: number; duplicates: number; cursorReset?: boolean };

/** Stores a message once. Either unique ID (Graph's or the RFC Message-ID) drops a duplicate. */
export async function storeInbound(m: InboundMessage): Promise<boolean> {
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

/**
 * One poll. The cursor is saved only after every page was stored, so a crash replays pages and the
 * unique IDs drop the repeats. An expired cursor restarts from the lookback window the same way.
 * dryRun reads and counts but stores nothing and keeps the cursor where it was.
 */
export async function pollInbox(
  reader: InboxReader,
  opts: { since?: Date; dryRun?: boolean; onMessage?: (m: InboundMessage) => void } = {},
): Promise<PollResult> {
  const [state] = await db.query<{ delta_link: string | null; since: string | null }>(
    "SELECT delta_link, since FROM mailbox_sync WHERE name = $1",
    [FOLDER],
  );
  const since =
    opts.since ??
    (state?.since ? new Date(state.since) : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000));

  const result: PollResult = { fetched: 0, stored: 0, duplicates: 0 };
  const onPage = async (messages: InboundMessage[]) => {
    for (const m of messages) {
      result.fetched++;
      opts.onMessage?.(m);
      if (opts.dryRun) continue;
      if (await storeInbound(m)) result.stored++;
      else result.duplicates++;
    }
  };

  let cursor = state?.delta_link ?? null;
  let next: string;
  try {
    next = await reader.readChanges(cursor, since, onPage);
  } catch (e) {
    if (!(e instanceof CursorExpiredError)) throw e;
    result.cursorReset = true;
    cursor = null;
    next = await reader.readChanges(null, since, onPage);
  }

  if (!opts.dryRun) {
    await db.query(
      `INSERT INTO mailbox_sync (name, delta_link, since, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET delta_link = $2, since = $3, updated_at = $4`,
      [FOLDER, next, since.toISOString(), new Date().toISOString()],
    );
  }
  return result;
}
