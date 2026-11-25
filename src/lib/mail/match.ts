import { db } from "../db.ts";
import { retainUntilForProject } from "../projectStatus.ts";

/**
 * Step 3b: decide which project a received message belongs to, and whether the sender is a vendor on it.
 *
 * Project, first rule that hits wins:
 *   1. subject_code  the [EN-...] code we put in the subject of the request
 *   2. conversation  the Graph conversation of an earlier message that was matched and verified
 *   3. header        In-Reply-To / References pointing at an earlier matched and verified message
 * No hit: Unmatched, for a person to assign.
 *
 * Sender: the domain must belong to an active vendor on the vendor list (intake address domain or the
 * vendor's `domains`). If not, the message is Unverified and never goes on to the model.
 * Matching never guesses: an unknown code, no hit or an unknown sender all stop at a person.
 */
export type MatchMethod = "subject_code" | "conversation" | "header" | "manual";
export type MatchStatus = "Matched" | "Unverified" | "Unmatched";

export type MatchResult = {
  status: MatchStatus;
  projectId: number | null;
  vendorId: number | null;
  method: MatchMethod | null;
  senderVerified: boolean;
};

type Row = {
  id: number;
  subject: string;
  from_address: string | null;
  conversation_id: string | null;
  headers: { name: string; value: string }[] | null;
};

const CODE = /\[(EN-[A-Z0-9]+-\d{4})\]/i;

export const domainOf = (address: string | null | undefined) => {
  const at = address?.lastIndexOf("@") ?? -1;
  return at > 0 ? address!.slice(at + 1).trim().toLowerCase() : null;
};

/** Message-IDs named in In-Reply-To and References, in the <id> form they travel in. */
export function referencedIds(headers: Row["headers"]): string[] {
  const ids = new Set<string>();
  for (const h of headers ?? []) {
    const n = h.name.toLowerCase();
    if (n === "in-reply-to" || n === "references") for (const m of h.value.match(/<[^<>\s]+>/g) ?? []) ids.add(m);
  }
  return [...ids];
}

type VendorRow = { id: number; intake_email: string | null; domains: string[] };
const vendorDomains = (v: VendorRow) =>
  new Set([domainOf(v.intake_email), ...v.domains.map((d) => d.toLowerCase())].filter((d): d is string => !!d));

/** Which project, and by which rule. */
async function findProject(m: Row): Promise<{ projectId: number; method: MatchMethod } | null> {
  const code = m.subject.match(CODE)?.[1];
  if (code) {
    const [p] = await db.query<{ id: number }>("SELECT id FROM projects WHERE upper(code) = upper($1)", [code]);
    if (p) return { projectId: p.id, method: "subject_code" };
  }
  if (m.conversation_id) {
    const [p] = await db.query<{ project_id: number }>(
      `SELECT project_id FROM inbound_messages
       WHERE conversation_id = $1 AND project_id IS NOT NULL AND status = 'Matched' AND id <> $2
       ORDER BY id LIMIT 1`,
      [m.conversation_id, m.id],
    );
    if (p) return { projectId: p.project_id, method: "conversation" };
  }
  const ids = referencedIds(m.headers);
  if (ids.length) {
    const [p] = await db.query<{ project_id: number }>(
      `SELECT project_id FROM inbound_messages
       WHERE internet_message_id = ANY($1) AND project_id IS NOT NULL AND status = 'Matched' AND id <> $2
       ORDER BY id LIMIT 1`,
      [ids, m.id],
    );
    if (p) return { projectId: p.project_id, method: "header" };
  }
  return null;
}

/**
 * Is the sender from a known vendor? Verified means the sender's domain belongs to any active vendor on
 * the vendor list. The vendor is named only when it is certain and it is one of the project's vendors.
 */
async function checkSender(address: string | null, projectId: number | null) {
  const domain = domainOf(address);
  if (!domain) return { verified: false, vendorId: null };
  const vendors = await db.query<VendorRow & { on_project: boolean }>(
    `SELECT v.id, v.intake_email, v.domains, (pv.vendor_id IS NOT NULL) AS on_project
     FROM vendors v LEFT JOIN project_vendors pv ON pv.vendor_id = v.id AND pv.project_id = $1
     WHERE v.active = 1`,
    [projectId],
  );
  const sameDomain = vendors.filter((v) => vendorDomains(v).has(domain));
  const onProject = sameDomain.filter((v) => v.on_project);
  const exact = onProject.filter((v) => v.intake_email?.toLowerCase() === address!.toLowerCase());
  // Exact address first; otherwise only a single project vendor on that domain is certain.
  const vendorId = exact.length === 1 ? exact[0].id : onProject.length === 1 ? onProject[0].id : null;
  return { verified: sameDomain.length > 0, vendorId };
}

export async function decide(m: Row, forced?: { projectId: number; method: MatchMethod }): Promise<MatchResult> {
  const found = forced ?? (await findProject(m));
  const sender = await checkSender(m.from_address, found?.projectId ?? null);
  if (!found) {
    return { status: "Unmatched", projectId: null, vendorId: null, method: null, senderVerified: sender.verified };
  }
  return {
    status: sender.verified ? "Matched" : "Unverified",
    projectId: found.projectId,
    vendorId: sender.vendorId,
    method: found.method,
    senderVerified: sender.verified,
  };
}

async function save(id: number, r: MatchResult) {
  await db.query(
    `UPDATE inbound_messages
     SET status = $2, project_id = $3, vendor_id = $4, match_method = $5, sender_verified = $6, matched_at = $7
     WHERE id = $1`,
    [id, r.status, r.projectId, r.vendorId, r.method, r.senderVerified, new Date().toISOString()],
  );
  // Mail for a project that is already closed expires on the same terms as the rest of its mail.
  if (r.projectId) {
    const until = await retainUntilForProject(r.projectId);
    if (until) await db.query("UPDATE inbound_messages SET retain_until = $2 WHERE id = $1", [id, until]);
  }
}

export type MatchCounts = { matched: number; unverified: number; unmatched: number };

/**
 * Matches every message still in `Received`, oldest first, so a reply can follow the earlier message it
 * answers. Safe to run any number of times. A failure leaves the rest in `Received` for the next run.
 */
export async function matchPending(): Promise<MatchCounts> {
  const counts: MatchCounts = { matched: 0, unverified: 0, unmatched: 0 };
  const rows = await db.query<Row>(
    `SELECT id, subject, from_address, conversation_id, headers FROM inbound_messages
     WHERE status = 'Received' ORDER BY received_at, id`,
  );
  for (const m of rows) {
    const r = await decide(m);
    await save(m.id, r);
    if (r.status === "Matched") counts.matched++;
    else if (r.status === "Unverified") counts.unverified++;
    else counts.unmatched++;
  }
  return counts;
}

/** A person puts an Unmatched (or wrongly matched) message on a project. The sender check still applies. */
export async function assignToProject(messageId: number, projectId: number): Promise<MatchResult> {
  const [m] = await db.query<Row>(
    "SELECT id, subject, from_address, conversation_id, headers FROM inbound_messages WHERE id = $1",
    [messageId],
  );
  if (!m) throw new Error(`No inbound message ${messageId}`);
  const [p] = await db.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
  if (!p) throw new Error(`No project ${projectId}`);
  const r = await decide(m, { projectId, method: "manual" });
  await save(messageId, r);
  return r;
}
