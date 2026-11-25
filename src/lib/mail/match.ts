import { db, tx } from "../db.ts";
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
 * vendor's `domains`; a personal-mail domain needs the vendor's exact address), and the receiving mail
 * system must have authenticated the sender (SPF, DKIM or DMARC). If not, the message is Unverified and
 * never goes on to the model.
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
  /** Why the sender was not verified (null when verified). */
  senderNote: string | null;
};

type Row = {
  id: number;
  subject: string;
  from_address: string | null;
  conversation_id: string | null;
  headers: { name: string; value: string }[] | null;
};

// Four digits is the minimum: the number is padded to four, but past 9999 it simply gets longer.
const CODE = /\[(EN-[A-Z0-9]+-\d{4,})\]/i;

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
    // A code that names no project is not guessed around: the message stays Unmatched for a person, even
    // if its thread or reply headers point somewhere.
    return p ? { projectId: p.id, method: "subject_code" } : null;
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

/** Personal mailbox providers: anyone can have an address there, so a domain match proves nothing. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "mail.com", "yandex.com", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com",
]);

/**
 * Did the receiving mail system authenticate the sender? Read from the headers Exchange adds.
 *   - mail from inside our own tenant (AuthAs: Internal) counts
 *   - otherwise DMARC must have passed. SPF or DKIM passing alone is not enough: they can pass for a
 *     domain that is not the one shown in From, and only DMARC checks that the two line up
 *   - anything else (fail, none, no header) does not
 * Only the topmost copy of each header is read: the receiving server adds its own on top, while a header
 * the sender included sits below it and could claim anything. The result is read as a structured field,
 * not searched as text: the text contains values the sender controls (the From and envelope domains,
 * comments, quoted reasons), and a search for "dmarc=pass" would find a match planted in any of them.
 * SENDER_AUTH=off skips the check (local development without real vendor mail). Default: on.
 */
export function senderAuthenticated(
  headers: Row["headers"],
  env: Record<string, string | undefined> = process.env,
): boolean {
  if ((env.SENDER_AUTH ?? "").trim().toLowerCase() === "off") return true;
  const top = (name: string) => (headers ?? []).find((h) => h.name.toLowerCase() === name)?.value;
  if (top("x-ms-exchange-organization-authas")?.trim().toLowerCase() === "internal") return true;
  const dmarc = authResults(top("authentication-results") ?? "").filter((r) => r.method === "dmarc");
  // Every DMARC result must be a pass (a second, failing one is not ignored), and there must be one.
  return dmarc.length > 0 && dmarc.every((r) => r.result === "pass");
}

/**
 * The method results in an Authentication-Results header ("dmarc=pass", "spf=fail", ...), read the way
 * the format defines them: after the server name, each result starts a segment separated by `;`.
 * Comments in parentheses and quoted strings are removed first, since they can carry text the sender
 * influences, and a result is only taken from the start of a segment, never from inside a property value.
 */
export function authResults(value: string): { method: string; result: string }[] {
  let s = value.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (let i = 0; i < 20 && /\([^()]*\)/.test(s); i++) s = s.replace(/\([^()]*\)/g, " "); // nested comments too
  const segments = s.split(";").map((p) => p.trim()).filter(Boolean);
  const out: { method: string; result: string }[] = [];
  for (const seg of segments.slice(1)) {
    // slice(1): the first segment is the server name (and version), not a result
    const m = seg.match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z][a-z0-9-]*)/i);
    if (m) out.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase() });
  }
  return out;
}

type SenderCheck = { verified: boolean; vendorId: number | null; note: string | null };

/**
 * Is the sender from a known vendor, and was the sender authenticated?
 * Domain: the sender's domain belongs to an active vendor on the vendor list. A personal-mail domain
 * never counts as a domain; there only a vendor's exact intake address does.
 * The vendor is named only when it is certain and it is one of the project's vendors.
 */
async function checkSender(
  address: string | null,
  projectId: number | null,
  headers: Row["headers"],
  env: Record<string, string | undefined>,
): Promise<SenderCheck> {
  const domain = domainOf(address);
  if (!domain) return { verified: false, vendorId: null, note: "no sender address" };
  const vendors = await db.query<VendorRow & { on_project: boolean }>(
    `SELECT v.id, v.intake_email, v.domains, (pv.vendor_id IS NOT NULL) AS on_project
     FROM vendors v LEFT JOIN project_vendors pv ON pv.vendor_id = v.id AND pv.project_id = $1
     WHERE v.active = 1`,
    [projectId],
  );
  const free = FREE_MAIL_DOMAINS.has(domain);
  const known = vendors.filter((v) =>
    free ? v.intake_email?.toLowerCase() === address!.toLowerCase() : vendorDomains(v).has(domain),
  );
  if (!known.length) {
    return {
      verified: false,
      vendorId: null,
      note: free ? "personal-mail address that is not a vendor's own address" : "sender domain is not on the vendor list",
    };
  }
  // Exact address first, against every known vendor: if the sender is another vendor's own address, that
  // is who it is, and it is named only when that vendor is on the project (never swapped for a project
  // vendor that merely shares the domain). Without an exact address, only a single project vendor on the
  // domain is certain.
  const exact = known.filter((v) => v.intake_email?.toLowerCase() === address!.toLowerCase());
  const onProject = known.filter((v) => v.on_project);
  const vendorId =
    exact.length === 1 ? (exact[0].on_project ? exact[0].id : null) : onProject.length === 1 ? onProject[0].id : null;
  if (!senderAuthenticated(headers, env)) {
    return { verified: false, vendorId, note: "sender not authenticated (SPF, DKIM or DMARC)" };
  }
  return { verified: true, vendorId, note: null };
}

export async function decide(
  m: Row,
  forced?: { projectId: number; method: MatchMethod },
  env: Record<string, string | undefined> = process.env,
): Promise<MatchResult> {
  const found = forced ?? (await findProject(m));
  const sender = await checkSender(m.from_address, found?.projectId ?? null, m.headers, env);
  if (!found) {
    return {
      status: "Unmatched",
      projectId: null,
      vendorId: null,
      method: null,
      senderVerified: sender.verified,
      senderNote: sender.note,
    };
  }
  return {
    status: sender.verified ? "Matched" : "Unverified",
    projectId: found.projectId,
    vendorId: sender.vendorId,
    method: found.method,
    senderVerified: sender.verified,
    senderNote: sender.note,
  };
}

/**
 * Writes the outcome. The retention date always follows the project the message is on now (none if it
 * has no project or the project is not closed), so a re-assigned message never keeps another project's
 * date. A message that is no longer Matched loses its stored attachments: untrusted mail keeps no files.
 * An automatic save (`onlyIfReceived`) only writes if the message is still Received: matching works from a
 * snapshot, so a person may have assigned the message meanwhile, and their decision must stand. A manual
 * assignment is an explicit override and always writes. Returns whether anything was written.
 */
async function save(id: number, r: MatchResult, onlyIfReceived = false): Promise<boolean> {
  return tx(async (q) => {
    // Read inside the transaction, under a shared lock on the project, so a project being closed at this
    // very moment cannot leave this message without the retention date its close gives it.
    const until = r.projectId ? await retainUntilForProject(q, r.projectId) : null;
    const rows = await q.query(
      `UPDATE inbound_messages
       SET status = $2, project_id = $3, vendor_id = $4, match_method = $5, sender_verified = $6,
           sender_note = $7, matched_at = $8, retain_until = $9
       WHERE id = $1 ${onlyIfReceived ? "AND status = 'Received'" : ""}
       RETURNING id`,
      [id, r.status, r.projectId, r.vendorId, r.method, r.senderVerified, r.senderNote, new Date().toISOString(), until],
    );
    if (!rows.length) return false; // changed by someone else since it was read: write nothing more
    if (r.status !== "Matched") {
      // Untrusted mail keeps nothing derived from it: no files, no cleaned text, no links. If it is verified
      // later, the poll produces them again.
      await q.query("DELETE FROM inbound_attachments WHERE message_id = $1", [id]);
      await q.query("DELETE FROM inbound_links WHERE message_id = $1", [id]);
      // What the model made of it goes too, unless a person has already confirmed a candidate from it.
      await q.query(
        `DELETE FROM extractions e WHERE e.message_id = $1 AND NOT EXISTS
           (SELECT 1 FROM extracted_candidates c WHERE c.extraction_id = e.id AND c.review_status = 'Confirmed')`,
        [id],
      );
      await q.query(
        `UPDATE inbound_messages
         SET attachments_fetched_at = NULL, attachments_attempts = 0, attachments_error = NULL,
             text_clean = NULL, text_removed = NULL, clean_info = NULL, cleaned_at = NULL, clean_version = NULL,
             clean_attempts = 0, clean_error = NULL, extraction_attempts = 0, extraction_error = NULL
         WHERE id = $1`,
        [id],
      );
    }
    return true;
  });
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
    if (!(await save(m.id, r, true))) continue; // a person got there first: leave their decision alone
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
