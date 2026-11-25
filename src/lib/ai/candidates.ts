import type { Queryable } from "../db.ts";
import type { Candidate } from "./schema.ts";

/**
 * Is this candidate one we have already seen from this vendor on this project?
 *
 *   Suggested update  same vendor, same project, same normalised name AND same normalised employer, and exactly
 *                     one earlier candidate fits. It is only a suggestion: a person decides in the review.
 *   Ambiguous         anything less certain: the same name with a different or missing employer, a matching
 *                     surname with the same first initial, or more than one earlier candidate that fits.
 *   New               nothing earlier fits.
 *
 * Nothing is ever merged automatically. An ambiguous match is shown to the reviewer as a question.
 */
export type MatchStatus = "New" | "Suggested update" | "Ambiguous";
export type Match = { status: MatchStatus; matches: number[] };

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "professor", "sir", "dame"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "mba", "cfa", "cpa", "esq"]);
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "ag",
  "sa", "sas", "bv", "nv", "plc", "pty", "oy", "ab", "as", "srl", "spa", "holdings", "group",
]);

const words = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // accents
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** "Dr. José A. García, PhD" -> "jose a garcia". */
export function normName(name: string): string {
  return words(name)
    .filter((w) => !HONORIFICS.has(w) && !NAME_SUFFIXES.has(w))
    .join(" ");
}

/** "The Acme Corp., Inc." -> "acme". */
export function normEmployer(employer: string | undefined): string {
  if (!employer) return "";
  const w = words(employer).filter((x) => x !== "the");
  while (w.length > 1 && COMPANY_SUFFIXES.has(w[w.length - 1])) w.pop();
  return w.join(" ");
}

const parts = (n: string) => n.split(" ").filter(Boolean);
const first = (n: string) => parts(n)[0] ?? "";
const last = (n: string) => parts(n).at(-1) ?? "";

/** Same surname and same first initial, with the names not identical (J. Smith / John Smith). */
const similarName = (a: string, b: string) =>
  a !== b && parts(a).length >= 2 && parts(b).length >= 2 && last(a) === last(b) && first(a)[0] === first(b)[0];

export type Earlier = { id: number; name_norm: string; employer_norm: string };

export function matchCandidate(name: string, employer: string, earlier: Earlier[]): Match {
  const exact = earlier.filter((e) => e.name_norm === name && !!employer && e.employer_norm === employer);
  if (exact.length === 1) return { status: "Suggested update", matches: [exact[0].id] };
  if (exact.length > 1) return { status: "Ambiguous", matches: exact.map((e) => e.id) };
  const sameName = earlier.filter((e) => e.name_norm === name);
  const alike = earlier.filter((e) => similarName(e.name_norm, name));
  const maybe = [...sameName, ...alike];
  return maybe.length ? { status: "Ambiguous", matches: maybe.map((e) => e.id) } : { status: "New", matches: [] };
}

/** Earlier candidates from the same vendor and project, for other messages, that were not rejected. */
export async function earlierCandidates(
  q: Queryable,
  projectId: number,
  vendorId: number | null,
  exceptMessageId: number,
): Promise<Earlier[]> {
  return q.query<Earlier>(
    `SELECT id, name_norm, employer_norm FROM extracted_candidates
     WHERE project_id = $1 AND vendor_id IS NOT DISTINCT FROM $2 AND message_id <> $3 AND review_status <> 'Rejected'
     ORDER BY id`,
    [projectId, vendorId, exceptMessageId],
  );
}

export const keysOf = (c: Candidate) => ({
  nameNorm: normName(c.name.value),
  employerNorm: normEmployer(c.current_employer?.value),
});
