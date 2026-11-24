import { db, tx } from "./db";
import { getDeal, getUser, isEligibleDeal } from "./dealcloud";
import {
  ELIGIBLE_DEAL_STATUSES,
  EXPERT_TYPES,
  type BriefInput,
  type FieldErrors,
  type Person,
  type Vendor,
} from "./types";

export type ProjectRow = {
  id: number;
  code: string;
  title: string;
  status: string;
  deal_id: string;
  deal_name: string;
  deal_status: string;
  deal_stage: string;
  company_name: string;
  sector: string;
  requester_id: string;
  requester_name: string;
  brief: string;
  created_at: string;
};

export type Member = { user_id: string; user_name: string; user_email: string; role: string };

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function listVendors(): Promise<Vendor[]> {
  return db.query<Vendor>("SELECT id, name FROM vendors WHERE active = 1 ORDER BY id");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, maxItems: number, maxLen = 200) =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => str(x, maxLen)).filter(Boolean))].slice(0, maxItems)
    : [];
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Normalises untrusted input and returns field-level errors. Server is the authority. */
export async function validateBrief(raw: unknown, requester: Person) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: FieldErrors = {};

  const input: BriefInput = {
    dealId: str(r.dealId, 64),
    title: str(r.title, 140),
    objective: str(r.objective, 5000),
    targetCompanies: list(r.targetCompanies, 20),
    competitors: list(r.competitors, 30),
    targetLogos: list(r.targetLogos, 100),
    expertTypes: list(r.expertTypes, 10).filter((t) =>
      (EXPERT_TYPES as readonly string[]).includes(t),
    ),
    decisionMakerRequired: r.decisionMakerRequired === true,
    geography: str(r.geography, 200),
    screener: list(r.screener, 12, 600),
    callsTarget: Number(r.callsTarget),
    startDate: str(r.startDate, 10),
    endDate: str(r.endDate, 10),
    vendorIds: Array.isArray(r.vendorIds)
      ? [...new Set(r.vendorIds.map(Number).filter(Number.isInteger))]
      : [],
    teamUserIds: list(r.teamUserIds, 40, 64).filter((id) => id !== requester.id),
    complianceNotes: str(r.complianceNotes, 3000),
    additionalNotes: str(r.additionalNotes, 3000),
  };

  // Mandatory DealCloud link, re-checked server-side at the moment of submission.
  const deal = input.dealId ? getDeal(input.dealId) : undefined;
  if (!input.dealId) errors.dealId = "Link this project to a DealCloud deal.";
  else if (!isEligibleDeal(deal))
    errors.dealId = `That deal is not ${ELIGIBLE_DEAL_STATUSES.join(" or ")} in DealCloud. Choose another deal.`;

  if (!input.title) errors.title = "Give the project a title.";
  if (!input.objective) errors.objective = "Describe what the team wants to learn.";
  if (!input.targetCompanies.length) errors.targetCompanies = "Add at least one target company.";
  if (!input.expertTypes.length) errors.expertTypes = "Choose at least one expert type.";

  if (!Number.isInteger(input.callsTarget) || input.callsTarget < 1 || input.callsTarget > 50)
    errors.callsTarget = "Enter a number of calls between 1 and 50.";

  const today = localToday();
  if (!isDate(input.startDate)) input.startDate = today;
  if (!isDate(input.endDate)) errors.endDate = "Set the date calls are needed by.";
  else if (input.endDate < today) errors.endDate = "The deadline cannot be in the past.";
  else if (input.endDate < input.startDate)
    errors.endDate = "The deadline must be on or after the start date.";

  const known = new Set((await listVendors()).map((v) => v.id));
  input.vendorIds = input.vendorIds.filter((id) => known.has(id));
  if (!input.vendorIds.length) errors.vendorIds = "Choose at least one expert network.";

  const unknownUser = input.teamUserIds.find((id) => !getUser(id));
  if (unknownUser) errors.teamUserIds = "One of the tagged people is not an active FTV user.";

  return { input, deal, errors, ok: Object.keys(errors).length === 0 };
}

/** The request as an expert network receives it. Never includes the internal deal link. */
export function buildNetworkBrief(input: BriefInput, requester: Person): string {
  const lines: string[] = [
    "Hi all,",
    "",
    input.objective,
    "",
    `Target company: ${input.targetCompanies.join(", ")}`,
  ];
  if (input.competitors.length) lines.push(`Known competitors: ${input.competitors.join(", ")}`);
  lines.push(
    `Expert profiles: ${input.expertTypes.join(", ")}${
      input.decisionMakerRequired ? " (key decision makers only)" : ""
    }`,
  );
  if (input.targetLogos.length)
    lines.push(`Organisations to source from: ${input.targetLogos.join(", ")}`);
  if (input.geography) lines.push(`Geography: ${input.geography}`);
  lines.push(
    `Calls requested: ${input.callsTarget}`,
    `Window: ${input.startDate} to ${input.endDate}`,
  );
  if (input.screener.length) {
    lines.push("", "Please use the screener below:");
    input.screener.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
  }
  if (input.complianceNotes) lines.push("", `Exclusions: ${input.complianceNotes}`);
  if (input.additionalNotes) lines.push("", input.additionalNotes);
  lines.push("", "Best,", requester.name, `${requester.title} | FTV Capital`);
  return lines.join("\n");
}

export async function createProject(
  raw: unknown,
  requester: Person,
): Promise<{ ok: true; id: number } | { ok: false; errors: FieldErrors }> {
  const { input, deal, errors, ok } = await validateBrief(raw, requester);
  if (!ok || !deal) return { ok: false, errors };

  const now = new Date().toISOString();
  const tagged = input.teamUserIds.map((id) => getUser(id)!);
  const networkBrief = buildNetworkBrief(input, requester);

  const id = await tx(async (q) => {
    const [row] = await q.query<{ id: number }>(
      `INSERT INTO projects (title, deal_id, deal_name, deal_status, deal_stage, company_name,
         sector, requester_id, requester_name, brief, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        input.title,
        deal.id,
        deal.name,
        deal.status,
        deal.stage,
        deal.companyName,
        deal.sector,
        requester.id,
        requester.name,
        JSON.stringify(input),
        now,
      ],
    );
    const pid = row.id;
    const code = `EN-${now.slice(0, 4)}-${String(pid).padStart(4, "0")}`;
    await q.query("UPDATE projects SET code = $1 WHERE id = $2", [code, pid]);

    const addMember = (u: Person, role: string) =>
      q.query(
        "INSERT INTO project_members (project_id, user_id, user_name, user_email, role) VALUES ($1, $2, $3, $4, $5)",
        [pid, u.id, u.name, u.email, role],
      );
    const queue = (kind: string, recipient: string, subject: string, body: string) =>
      q.query(
        "INSERT INTO outbox (project_id, kind, recipient, subject, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [pid, kind, recipient, subject, body, now],
      );

    await addMember(requester, "Requester");

    const message = `${requester.name} tagged you on expert network project ${code}: ${input.title} (${deal.name})`;
    for (const u of tagged) {
      await addMember(u, "Team");
      await q.query(
        "INSERT INTO notifications (user_id, project_id, message, created_at) VALUES ($1, $2, $3, $4)",
        [u.id, pid, message, now],
      );
      await queue("team-notification", u.email, `[${code}] ${input.title}`, message);
    }

    for (const vid of input.vendorIds) {
      await q.query("INSERT INTO project_vendors (project_id, vendor_id) VALUES ($1, $2)", [
        pid,
        vid,
      ]);
      const [v] = await q.query<{ name: string; intake_email: string | null }>(
        "SELECT name, intake_email FROM vendors WHERE id = $1",
        [vid],
      );
      if (!v.intake_email) throw new Error(`Vendor ${v.name} has no intake email configured`);
      await queue("network-brief", v.intake_email, `[${code}] ${input.title}`, networkBrief);
    }
    return pid;
  });

  return { ok: true, id };
}

export async function listProjectsFor(userId: string): Promise<ProjectRow[]> {
  return db.query<ProjectRow>(
    `SELECT p.* FROM projects p
     JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
     ORDER BY p.created_at DESC`,
    [userId],
  );
}

/** Returns the project only if the user is a member (requester or tagged). */
export async function getProjectFor(id: number, userId: string) {
  const [project] = await db.query<ProjectRow>(
    `SELECT p.* FROM projects p
     JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
     WHERE p.id = $2`,
    [userId, id],
  );
  if (!project) return undefined;
  const members = await db.query<Member>(
    "SELECT user_id, user_name, user_email, role FROM project_members WHERE project_id = $1 ORDER BY role, user_name",
    [id],
  );
  const vendors = await db.query<{ name: string; status: string }>(
    `SELECT v.name, pv.status FROM project_vendors pv JOIN vendors v ON v.id = pv.vendor_id
     WHERE pv.project_id = $1 ORDER BY v.id`,
    [id],
  );
  const brief = JSON.parse(project.brief) as BriefInput;
  return { project, members, vendors, brief };
}

export type NotificationRow = {
  id: number;
  project_id: number | null;
  message: string;
  read_at: string | null;
  created_at: string;
};

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId],
  );
  return row.n;
}

export async function listNotifications(userId: string): Promise<NotificationRow[]> {
  return db.query<NotificationRow>(
    "SELECT id, project_id, message, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
    [userId],
  );
}

export async function markAllRead(userId: string) {
  await db.query("UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL", [
    new Date().toISOString(),
    userId,
  ]);
}
