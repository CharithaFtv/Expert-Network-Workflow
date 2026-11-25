import { db, tx } from "./db.ts";

/**
 * Project states and who may move a project between them.
 *
 *   Just opened -> Ongoing -> Compliance -> Closed
 *
 * Compliance can go back to Ongoing (a reviewer sends it back). Closed is final: closing starts the
 * retention clock, so reopening would be misleading once content has been purged.
 * Any project member can move a project, but only the requester can close it.
 */
export const PROJECT_STATUSES = ["Just opened", "Ongoing", "Compliance", "Closed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const NEXT: Record<ProjectStatus, readonly ProjectStatus[]> = {
  "Just opened": ["Ongoing", "Closed"],
  Ongoing: ["Compliance", "Closed"],
  Compliance: ["Ongoing", "Closed"],
  Closed: [],
};

export const isProjectStatus = (s: unknown): s is ProjectStatus =>
  typeof s === "string" && (PROJECT_STATUSES as readonly string[]).includes(s);

export const nextStatuses = (from: string): readonly ProjectStatus[] => (isProjectStatus(from) ? NEXT[from] : []);

/**
 * Days to keep a closed project's mail before it is due for purging, or null when no period is set.
 * Null means closing a project makes nothing due: no retention date is set until a period is agreed.
 * 0 means due as soon as the project closes. Nothing is deleted until `npm run purge-inbox -- --apply` runs.
 */
export function retentionDaysAfterClose(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.RETENTION_DAYS_AFTER_CLOSE;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3650) {
    throw new Error("RETENTION_DAYS_AFTER_CLOSE must be a whole number of days, 0 to 3650.");
  }
  return n;
}

export const retainUntilAfterClose = (closedAt: string, days: number) =>
  new Date(new Date(closedAt).getTime() + days * 86_400_000).toISOString();

export type StatusChange =
  | { ok: true; status: ProjectStatus }
  | { ok: false; code: "not_found" | "forbidden" | "invalid" | "not_allowed"; error: string };

export async function changeProjectStatus(
  projectId: number,
  user: { id: string; name: string },
  to: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<StatusChange> {
  if (!isProjectStatus(to)) return { ok: false, code: "invalid", error: "Unknown status." };
  const days = retentionDaysAfterClose(env);

  return tx(async (q): Promise<StatusChange> => {
    // Lock the project row so two people cannot move it at once.
    const [p] = await q.query<{ status: string; requester_id: string }>(
      "SELECT status, requester_id FROM projects WHERE id = $1 FOR UPDATE",
      [projectId],
    );
    const [member] = p
      ? await q.query("SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, user.id])
      : [];
    // A project the user cannot see is reported as missing, the same as a project that does not exist.
    if (!p || !member) return { ok: false, code: "not_found", error: "Project not found." };
    if (!nextStatuses(p.status).includes(to)) {
      return { ok: false, code: "not_allowed", error: `A project cannot move from ${p.status} to ${to}.` };
    }
    if (to === "Closed" && p.requester_id !== user.id) {
      return { ok: false, code: "forbidden", error: "Only the requester can close a project." };
    }

    const now = new Date().toISOString();
    await q.query("UPDATE projects SET status = $2, closed_at = $3 WHERE id = $1", [
      projectId,
      to,
      to === "Closed" ? now : null,
    ]);
    await q.query(
      `INSERT INTO project_status_log (project_id, from_status, to_status, user_id, user_name, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [projectId, p.status, to, user.id, user.name, now],
    );
    if (to === "Closed" && days !== null) {
      // Start the retention clock for everything already received on this project.
      // With no period set (days is null) nothing is made due.
      await q.query(
        "UPDATE inbound_messages SET retain_until = $2 WHERE project_id = $1 AND retain_until IS NULL AND purged_at IS NULL",
        [projectId, retainUntilAfterClose(now, days)],
      );
    }
    return { ok: true, status: to };
  });
}

/** A message that arrives for a project that is already closed expires on the same terms. */
export async function retainUntilForProject(projectId: number): Promise<string | null> {
  const [p] = await db.query<{ closed_at: string | null }>("SELECT closed_at FROM projects WHERE id = $1", [projectId]);
  const days = retentionDaysAfterClose();
  return p?.closed_at && days !== null ? retainUntilAfterClose(p.closed_at, days) : null;
}
