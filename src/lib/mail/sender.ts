import { db } from "../db.ts";
import { MailError, type MailTransport, type SendReceipt } from "./transport.ts";

export const MAX_ATTEMPTS = 3;

type Row = { id: number; recipient: string; subject: string; body: string; attempts: number };

export type SendResult = {
  sent: number;
  failed: number;
  retried: number;
  /** Rows left in Sending by a crash. Never resent automatically: check Sent Items, then resolve by hand. */
  stuck: number;
  /** Set when the run stopped early because of a run-level problem (auth, throttling, outage). */
  aborted?: string;
};

/**
 * Drains Queued outbox rows, claim-then-send:
 *  1. claim a row (Queued -> Sending) in one atomic statement; SKIP LOCKED keeps runners apart
 *  2. send with no DB transaction or lock held
 *  3. record Sent / Failed / back to Queued in a separate statement
 * A crash between 2 and 3 leaves the row in Sending (reported as `stuck`), never resent,
 * so a vendor cannot receive the same brief twice because of our bookkeeping.
 * If `redirectTo` is set, every email goes there instead (original recipient noted in the body).
 */
export async function drainOutbox(
  transport: MailTransport,
  opts: { redirectTo?: string; batch?: number } = {},
): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, retried: 0, stuck: 0 };
  const batch = opts.batch ?? 25;
  const tried: number[] = []; // a failed row waits for the next run, not the next loop

  for (let i = 0; i < batch; i++) {
    const [row] = await db.query<Row>(
      `UPDATE outbox SET status = 'Sending', claimed_at = $2
        WHERE id = (SELECT id FROM outbox WHERE status = 'Queued' AND id <> ALL($1::int[])
                    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, recipient, subject, body, attempts`,
      [tried, new Date().toISOString()],
    );
    if (!row) break;
    tried.push(row.id);

    const to = opts.redirectTo || row.recipient;
    const body = opts.redirectTo
      ? `[Redirected for testing. Original recipient: ${row.recipient}]\n\n${row.body}`
      : row.body;

    let error: unknown;
    let receipt: SendReceipt | void = undefined;
    try {
      receipt = await transport.send({ to, subject: row.subject, body });
    } catch (e) {
      error = e;
    }

    if (!error) {
      await db.query(
        `UPDATE outbox SET status='Sent', sent_at=$2, attempts=attempts+1, last_error=NULL,
           conversation_id=$3, internet_message_id=$4 WHERE id=$1`,
        [row.id, new Date().toISOString(), receipt?.conversationId ?? null, receipt?.internetMessageId ?? null],
      );
      result.sent++;
      continue;
    }

    const message = String((error as Error).message).slice(0, 1000);
    if (error instanceof MailError && error.kind === "run") {
      // Not this message's fault: put it back untouched and stop the run.
      await db.query("UPDATE outbox SET status='Queued', last_error=$2 WHERE id=$1", [row.id, message]);
      result.aborted = message;
      break;
    }
    const attempts = row.attempts + 1;
    const permanent = error instanceof MailError && error.kind === "permanent";
    const status = permanent || attempts >= MAX_ATTEMPTS ? "Failed" : "Queued";
    await db.query("UPDATE outbox SET status=$2, attempts=$3, last_error=$4 WHERE id=$1", [
      row.id,
      status,
      attempts,
      message,
    ]);
    if (status === "Failed") result.failed++;
    else result.retried++;
  }

  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE status = 'Sending'");
  result.stuck = n;
  return result;
}

/** Puts every Failed row back in the queue with a fresh attempt count. Returns how many. */
export async function requeueFailed(): Promise<number> {
  const rows = await db.query(
    "UPDATE outbox SET status='Queued', attempts=0 WHERE status='Failed' RETURNING id",
  );
  return rows.length;
}
