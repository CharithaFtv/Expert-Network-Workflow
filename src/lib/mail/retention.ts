import { db } from "../db.ts";
import { retainUntilAfterClose, retentionDaysAfterClose } from "../projectStatus.ts";

type Env = Record<string, string | undefined>;

/**
 * Gives mail on already-closed projects a retention date once a retention period is set. A project that
 * was closed while no period was set left its mail with no date; this applies the period from the day each
 * project closed. Does nothing while the period is unset. Run by `npm run purge-inbox -- --apply`.
 */
export async function backfillRetention(env: Env = process.env): Promise<number> {
  const days = retentionDaysAfterClose(env);
  if (days === null) return 0;
  const projects = await db.query<{ id: number; closed_at: string }>(
    `SELECT DISTINCT p.id, p.closed_at FROM projects p
     JOIN inbound_messages m ON m.project_id = p.id
     WHERE p.status = 'Closed' AND p.closed_at IS NOT NULL AND m.retain_until IS NULL AND m.purged_at IS NULL`,
  );
  let n = 0;
  for (const p of projects) {
    const rows = await db.query(
      `UPDATE inbound_messages SET retain_until = $2
       WHERE project_id = $1 AND retain_until IS NULL AND purged_at IS NULL RETURNING id`,
      [p.id, retainUntilAfterClose(p.closed_at, days)],
    );
    n += rows.length;
  }
  return n;
}

export type DueRow = { project: string; messages: number; attachments: number };

/**
 * What a purge would remove right now, per project, without changing anything. Counts messages that are
 * already dated and past it, and messages on closed projects that the backfill would date and that are
 * then past it.
 */
export async function dueForPurge(now = new Date(), env: Env = process.env): Promise<DueRow[]> {
  const days = retentionDaysAfterClose(env);
  const stamp = now.toISOString();
  const rows = await db.query<{ code: string; retain_until: string | null; closed_at: string | null; attachments: number }>(
    `SELECT p.code, m.retain_until, p.closed_at,
            (SELECT COUNT(*) FROM inbound_attachments a WHERE a.message_id = m.id AND a.status = 'Stored') AS attachments
     FROM inbound_messages m JOIN projects p ON p.id = m.project_id
     WHERE m.purged_at IS NULL AND (m.retain_until IS NOT NULL OR p.closed_at IS NOT NULL)`,
  );
  const byProject = new Map<string, DueRow>();
  for (const r of rows) {
    const due = r.retain_until
      ? r.retain_until <= stamp
      : days !== null && r.closed_at !== null && retainUntilAfterClose(r.closed_at, days) <= stamp;
    if (!due) continue;
    const row = byProject.get(r.code) ?? { project: r.code, messages: 0, attachments: 0 };
    row.messages++;
    row.attachments += Number(r.attachments);
    byProject.set(r.code, row);
  }
  return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}
