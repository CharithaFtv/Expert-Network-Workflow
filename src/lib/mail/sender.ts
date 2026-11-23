import { tx } from "../db.ts";
import type { MailTransport } from "./transport.ts";

export const MAX_ATTEMPTS = 3;

type Row = { id: number; recipient: string; subject: string; body: string; attempts: number };

export type SendResult = { sent: number; failed: number; retried: number };

/**
 * Drains Queued outbox rows. Each row is claimed with FOR UPDATE SKIP LOCKED so two
 * runners never send the same email. If `redirectTo` is set, every email goes there instead
 * (the original recipient is noted in the body).
 */
export async function drainOutbox(
  transport: MailTransport,
  opts: { redirectTo?: string; batch?: number } = {},
): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, retried: 0 };
  const batch = opts.batch ?? 25;
  const tried: number[] = []; // a failed row waits for the next run, not the next loop

  for (let i = 0; i < batch; i++) {
    const more = await tx(async (q) => {
      const [row] = await q.query<Row>(
        `SELECT id, recipient, subject, body, attempts FROM outbox
         WHERE status = 'Queued' AND id <> ALL($1::int[]) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tried],
      );
      if (!row) return false;
      tried.push(row.id);

      const to = opts.redirectTo || row.recipient;
      const body = opts.redirectTo
        ? `[Redirected for testing. Original recipient: ${row.recipient}]\n\n${row.body}`
        : row.body;

      try {
        await transport.send({ to, subject: row.subject, body });
        await q.query("UPDATE outbox SET status='Sent', sent_at=$2, attempts=attempts+1, last_error=NULL WHERE id=$1", [
          row.id,
          new Date().toISOString(),
        ]);
        result.sent++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const status = attempts >= MAX_ATTEMPTS ? "Failed" : "Queued";
        await q.query("UPDATE outbox SET status=$2, attempts=$3, last_error=$4 WHERE id=$1", [
          row.id,
          status,
          attempts,
          String((e as Error).message).slice(0, 1000),
        ]);
        if (status === "Failed") result.failed++;
        else result.retried++;
      }
      return true;
    });
    if (!more) break;
  }
  return result;
}
