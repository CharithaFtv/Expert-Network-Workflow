import { db, tx } from "../db.ts";
import { earlierCandidates, keysOf, matchCandidate } from "./candidates.ts";
import { ModelError, type ModelClient, type ModelRequest } from "./model.ts";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM, neutralise, PROMPT_VERSION, userMessage } from "./prompts.ts";
import {
  CLASSIFY_SCHEMA,
  EXTRACT_SCHEMA,
  EXTRACTABLE,
  parseJson,
  validateClassification,
  validateExtraction,
  ValidationError,
  type Classification,
  type Extraction,
} from "./schema.ts";

/**
 * Step 3e: a fixed pipeline, not an agent.
 *
 *   1. classify  what kind of email is this?                       (one model call)
 *   2. extract   only for expert candidates and updates: the experts (one model call)
 *   3. validate  every field must have a quote that is in the email; the rest is dropped
 *   4. match     is a candidate someone this vendor already proposed on this project? (suggestion only)
 *
 * The model has no tools and sees no deal, project, vendor or internal note. Each call is retried once. A
 * message the model cannot handle is marked "Needs manual entry" and the workflow carries on: the AI is a
 * helper that can fail, never a step that blocks.
 */
export const MAX_INPUT_CHARS = 30_000;
/** Poll runs that may fail to reach the model for one message before it is marked for manual entry. */
export const MAX_EXTRACTION_TRIES = 5;
const PER_RUN_LIMIT = 20;

export type CallAudit = {
  step: "classify" | "extract";
  attempts: number;
  model: string;
  requestId: string | null;
  stopReason: string;
  usage: { input: number; output: number; cacheRead: number };
};

type Base = { calls: CallAudit[] };
export type PipelineOutcome =
  | (Base & { outcome: "classified"; classification: Classification; raw: { classification: unknown } })
  | (Base & {
      outcome: "extracted";
      classification: Classification;
      extraction: Extraction;
      raw: { classification: unknown; extraction: unknown };
    })
  | (Base & { outcome: "manual"; classification: Classification | null; reason: string; dropped: Extraction["dropped"] })
  | (Base & { outcome: "deferred"; error: ModelError })
  | (Base & { outcome: "aborted"; error: ModelError });

type Deps = { sleep?: (ms: number) => Promise<void> };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One model call with one retry: on a transient failure, or an answer that does not validate. */
async function step<T>(
  client: ModelClient,
  stepName: CallAudit["step"],
  req: ModelRequest,
  validate: (raw: unknown) => T,
  calls: CallAudit[],
  sleep: (ms: number) => Promise<void>,
): Promise<{ value: T; raw: unknown }> {
  let nudge = "";
  let last: Error = new Error("no attempt was made");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await client.complete({ ...req, user: req.user + nudge });
      const raw = parseJson(res.text);
      const value = validate(raw);
      calls.push({
        step: stepName,
        attempts: attempt,
        model: res.model,
        requestId: res.requestId,
        stopReason: res.stopReason,
        usage: res.usage,
      });
      return { value, raw };
    } catch (e) {
      if (e instanceof ModelError) {
        if (!e.retryable) throw e; // auth, refusal, rejected request: asking again will not help
        last = e;
        if (attempt === 1) await sleep(1000);
      } else if (e instanceof ValidationError) {
        last = e;
        // Tell the model what was wrong. The message names a rule, never the email text.
        nudge = `\n\nYour previous answer was rejected: ${e.message}. Answer again with only JSON that follows the schema.`;
      } else {
        throw e;
      }
    }
  }
  throw last;
}

export async function runPipeline(
  client: ModelClient,
  input: { text: string; linkHosts: string[] },
  deps: Deps = {},
): Promise<PipelineOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const calls: CallAudit[] = [];
  const user = userMessage(input.text, input.linkHosts);
  let classification: Classification | null = null;
  let dropped: Extraction["dropped"] = [];

  try {
    const c = await step(
      client,
      "classify",
      { system: CLASSIFY_SYSTEM, user, schema: CLASSIFY_SCHEMA, maxTokens: 4000, effort: "low" },
      validateClassification,
      calls,
      sleep,
    );
    classification = c.value;
    if (!EXTRACTABLE.includes(classification.category)) {
      return { outcome: "classified", classification, calls, raw: { classification: c.raw } };
    }

    const e = await step(
      client,
      "extract",
      { system: EXTRACT_SYSTEM, user, schema: EXTRACT_SCHEMA, maxTokens: 16000, effort: "medium" },
      (raw) => {
        const x = validateExtraction(raw, input.text);
        dropped = x.dropped;
        const offered = (raw as { candidates?: unknown[] }).candidates?.length ?? 0;
        // Offered some, none survived: ask once more, naming the rule that was broken.
        if (offered > 0 && x.candidates.length === 0) {
          throw new ValidationError("none of the candidates had a name and quotes that appear in the email");
        }
        return x;
      },
      calls,
      sleep,
    );
    if (e.value.candidates.length === 0) {
      return { outcome: "manual", classification, calls, reason: "the model found no expert in an email it called a proposal", dropped };
    }
    return { outcome: "extracted", classification, extraction: e.value, calls, raw: { classification: c.raw, extraction: e.raw } };
  } catch (err) {
    if (err instanceof ModelError) {
      if (err.kind === "auth") return { outcome: "aborted", error: err, calls };
      if (err.kind === "transient") return { outcome: "deferred", error: err, calls };
      // A rejected request that is about the setup (unknown model, bad parameter) would fail for every
      // message: stop the run instead of marking each one for manual entry.
      if (err.status === 400 || err.status === 404 || err.status === 422) return { outcome: "aborted", error: err, calls };
      return { outcome: "manual", classification, calls, reason: err.message, dropped };
    }
    if (err instanceof ValidationError) {
      return { outcome: "manual", classification, calls, reason: `the model's answer was not usable: ${err.message}`, dropped };
    }
    throw err;
  }
}

// --- applying it to stored messages -------------------------------------------------------------------

export type ExtractCounts = {
  /** Messages that got a result this run (including "Needs manual entry"). */
  messages: number;
  candidates: number;
  /** Not an expert email, so not extracted (acknowledgements, questions, scheduling). */
  classifiedOnly: number;
  manual: number;
  /** The model could not be reached; the message is tried again on a later poll. */
  deferred: number;
  /** A configuration problem stopped the run (the key is wrong); nothing else was tried. */
  aborted: string | null;
  errors: string[];
};

type Pending = {
  id: number;
  project_id: number;
  vendor_id: number | null;
  text_clean: string;
  extraction_attempts: number;
  hosts: string[] | null;
};

/** The messages waiting for extraction, in the order they are tried. Shared by the run and by --preview. */
export async function pendingMessages(limit = PER_RUN_LIMIT): Promise<Pending[]> {
  return db.query<Pending>(
    `SELECT m.id, m.project_id, m.vendor_id, m.text_clean, m.extraction_attempts,
            (SELECT array_agg(DISTINCT l.host) FROM inbound_links l WHERE l.message_id = m.id) AS hosts
     FROM inbound_messages m
     LEFT JOIN extractions e ON e.message_id = m.id
     WHERE m.status = 'Matched' AND m.cleaned_at IS NOT NULL AND m.purged_at IS NULL AND m.text_clean IS NOT NULL
       AND m.project_id IS NOT NULL AND e.id IS NULL AND m.extraction_attempts < $2
     ORDER BY m.extraction_attempts, m.id LIMIT $1`,
    [limit, MAX_EXTRACTION_TRIES],
  );
}

/** The text the model sees is exactly the text the quotes are checked against. */
export function prepareInput(textClean: string): { text: string; truncated: boolean } {
  const full = neutralise(textClean);
  const text = full.length > MAX_INPUT_CHARS ? full.slice(0, MAX_INPUT_CHARS) : full;
  return { text, truncated: text.length !== full.length };
}

export async function extractPending(
  client: ModelClient,
  opts: { limit?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ExtractCounts> {
  const counts: ExtractCounts = { messages: 0, candidates: 0, classifiedOnly: 0, manual: 0, deferred: 0, aborted: null, errors: [] };
  const rows = await pendingMessages(opts.limit);

  for (const m of rows) {
    const { text, truncated } = prepareInput(m.text_clean);

    if (!text.trim()) {
      if (await record(m, text, truncated, client, { kind: "skipped" })) counts.messages++;
      continue;
    }

    const out = await runPipeline(client, { text, linkHosts: m.hosts ?? [] }, { sleep: opts.sleep });

    if (out.outcome === "aborted") {
      counts.aborted = out.error.message;
      counts.errors.push(out.error.message);
      break; // every further call would fail the same way
    }
    if (out.outcome === "deferred") {
      counts.deferred++;
      const tries = m.extraction_attempts + 1;
      // Only if the message is still the one that was read: a re-clean or reassignment resets the count, and
      // this must not put a stale one back.
      const bumped = await db.query(
        `UPDATE inbound_messages SET extraction_attempts = $2, extraction_error = $3
         WHERE id = $1 AND extraction_attempts = $4 AND text_clean = $5 AND status = 'Matched'
           AND project_id IS NOT DISTINCT FROM $6 AND vendor_id IS NOT DISTINCT FROM $7 RETURNING id`,
        [m.id, tries, out.error.message.slice(0, 500), m.extraction_attempts, m.text_clean, m.project_id, m.vendor_id],
      );
      if (bumped.length && tries >= MAX_EXTRACTION_TRIES) {
        const reason = `the model could not be reached after ${tries} tries: ${out.error.message}`;
        if (await record(m, text, truncated, client, { kind: "manual", reason, calls: out.calls, dropped: [], classification: null })) {
          counts.messages++;
          counts.manual++;
        }
      }
      break; // the model is unreachable: do not spend the other messages' tries on the same outage
    }

    const wrote = await record(m, text, truncated, client, out.outcome === "classified"
      ? { kind: "classified", out }
      : out.outcome === "extracted"
        ? { kind: "extracted", out }
        : { kind: "manual", reason: out.reason, calls: out.calls, dropped: out.dropped, classification: out.classification });
    if (!wrote) continue;
    counts.messages++;
    if (out.outcome === "classified") counts.classifiedOnly++;
    else if (out.outcome === "extracted") counts.candidates += out.extraction.candidates.length;
    else counts.manual++;
  }
  return counts;
}

type Recorded =
  | { kind: "skipped" }
  | { kind: "classified"; out: Extract<PipelineOutcome, { outcome: "classified" }> }
  | { kind: "extracted"; out: Extract<PipelineOutcome, { outcome: "extracted" }> }
  | { kind: "manual"; reason: string; calls: CallAudit[]; dropped: Extraction["dropped"]; classification: Classification | null };

/** Writes one result under a row lock, only if the message is still Matched with the same clean text. */
async function record(m: Pending, shown: string, truncated: boolean, client: ModelClient, r: Recorded): Promise<boolean> {
  const now = new Date().toISOString();
  return tx(async (q) => {
    // Lock order matches closing a project and matching mail: the project first, then the message.
    await q.query("SELECT 1 FROM projects WHERE id = $1 FOR SHARE", [m.project_id]);
    // The model took a while; check that the message is still verified and its clean text is the text it read.
    const [cur] = await q.query<{ ok: boolean }>(
      `SELECT (status = 'Matched' AND purged_at IS NULL AND text_clean = $2
                AND project_id IS NOT DISTINCT FROM $3 AND vendor_id IS NOT DISTINCT FROM $4) AS ok
       FROM inbound_messages WHERE id = $1 FOR UPDATE`,
      [m.id, m.text_clean, m.project_id, m.vendor_id],
    );
    if (!cur?.ok) return false;
    const [dup] = await q.query("SELECT 1 FROM extractions WHERE message_id = $1", [m.id]);
    if (dup) return false;

    const status =
      r.kind === "skipped" ? "Skipped" : r.kind === "extracted" ? "Extracted" : r.kind === "classified" ? "Classified" : "Needs manual entry";
    const classification = r.kind === "classified" || r.kind === "extracted" ? r.out.classification : r.kind === "manual" ? r.classification : null;
    const calls = r.kind === "classified" || r.kind === "extracted" ? r.out.calls : r.kind === "manual" ? r.calls : [];
    const dropped = r.kind === "extracted" ? r.out.extraction.dropped : r.kind === "manual" ? r.dropped : [];
    const raw = r.kind === "classified" || r.kind === "extracted" ? r.out.raw : null;

    const [ex] = await q.query<{ id: number }>(
      `INSERT INTO extractions
         (message_id, status, category, confidence, reason, model, prompt_version, input_chars, truncated, error, audit, raw, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        m.id,
        status,
        classification?.category ?? null,
        classification?.confidence ?? null,
        classification?.reason ?? null,
        client.model,
        PROMPT_VERSION,
        shown.length,
        truncated,
        r.kind === "manual" ? r.reason.slice(0, 500) : null,
        JSON.stringify({ calls, dropped }),
        raw ? JSON.stringify(raw) : null,
        now,
      ],
    );

    if (r.kind === "extracted") {
      const earlier = await earlierCandidates(q, m.project_id, m.vendor_id, m.id);
      let position = 0;
      for (const c of r.out.extraction.candidates) {
        const { nameNorm, employerNorm } = keysOf(c);
        const match = matchCandidate(nameNorm, employerNorm, earlier);
        await q.query(
          `INSERT INTO extracted_candidates
             (extraction_id, message_id, project_id, vendor_id, position, data, name_norm, employer_norm, match_status, matches, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [ex.id, m.id, m.project_id, m.vendor_id, position++, JSON.stringify(c), nameNorm, employerNorm, match.status, match.matches, now],
        );
      }
    }
    await q.query("UPDATE inbound_messages SET extraction_error = NULL WHERE id = $1", [m.id]);
    return true;
  });
}
