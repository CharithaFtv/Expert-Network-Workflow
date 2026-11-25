/**
 * What the model may return, and how much of it we believe.
 *
 * The API is asked to follow these JSON schemas, but its answer is still treated as untrusted input: every
 * field is validated here, and every field must carry a quote that really occurs in the email. A field
 * whose quote cannot be found is dropped, and a candidate without a supported name is dropped whole. What
 * survives is data to be reviewed by a person, never an instruction or a fact.
 */
export const CATEGORIES = [
  "expert_candidates", // the vendor is proposing one or more experts
  "update", // new information about an expert already proposed (rate, availability, ...)
  "vendor_question", // the vendor asks us something
  "acknowledgement", // received, thanks, will revert
  "scheduling", // arranging a call or a time
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
/** Only these categories are sent on to extraction. */
export const EXTRACTABLE: readonly Category[] = ["expert_candidates", "update"];

export const RATE_UNITS = ["hour", "call", "day", "week", "month", "project", "other"] as const;

export type Field<T> = { value: T; confidence: number; quote: string };
export type PastRole = { title?: string; employer?: string; years?: string; confidence: number; quote: string };
export type Rate = { amount: number; currency: string; unit?: string; confidence: number; quote: string };
export type Candidate = {
  name: Field<string>;
  current_title?: Field<string>;
  current_employer?: Field<string>;
  past_roles?: PastRole[];
  geography?: Field<string>;
  years_experience?: Field<number>;
  rate?: Rate;
  availability?: Field<string>;
  vendor_notes?: Field<string>;
};
export type Classification = { category: Category; confidence: number; reason: string };
export type Dropped = { candidate: number | null; field: string; reason: string };

export class ValidationError extends Error {}

// --- the schemas sent to the API ---------------------------------------------------------------------

const str = { type: "string" };
const num = { type: "number" };
const textField = {
  type: "object",
  properties: { value: str, confidence: num, quote: str },
  required: ["value", "confidence", "quote"],
  additionalProperties: false,
};
const numberField = {
  type: "object",
  properties: { value: num, confidence: num, quote: str },
  required: ["value", "confidence", "quote"],
  additionalProperties: false,
};

export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: { category: { type: "string", enum: [...CATEGORIES] }, confidence: num, reason: str },
  required: ["category", "confidence", "reason"],
  additionalProperties: false,
};

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: textField,
          current_title: textField,
          current_employer: textField,
          past_roles: {
            type: "array",
            items: {
              type: "object",
              properties: { title: str, employer: str, years: str, confidence: num, quote: str },
              required: ["confidence", "quote"],
              additionalProperties: false,
            },
          },
          geography: textField,
          years_experience: numberField,
          rate: {
            type: "object",
            properties: {
              amount: num,
              currency: str,
              unit: { type: "string", enum: [...RATE_UNITS] },
              confidence: num,
              quote: str,
            },
            required: ["amount", "currency", "confidence", "quote"],
            additionalProperties: false,
          },
          availability: textField,
          vendor_notes: textField,
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

// --- quotes -------------------------------------------------------------------------------------------

/** Comparison form of a text: compatibility-normalised, lower case, straight quotes and dashes, one space. */
export function forQuote(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const MIN_QUOTE = 3;
const MAX_QUOTE = 500;

/** Does this quote occur in the email (ignoring case, spacing, and curly versus straight punctuation)? */
export function quoteInSource(quote: string, normSource: string): boolean {
  const q = forQuote(quote);
  return q.length >= MIN_QUOTE && q.length <= MAX_QUOTE && normSource.includes(q);
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50,
};

/** Does the quote contain this number, written in digits ("1,500", "1.5k") or as a small word ("fifteen")? */
export function numberInQuote(n: number, quote: string): boolean {
  const q = forQuote(quote);
  for (const m of q.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/g)) {
    const v = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (Math.abs(v - n) < 1e-9) return true;
  }
  for (const w of q.split(/[^a-z]+/)) if (WORDS[w] === n) return true;
  return false;
}

// --- validation ---------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const MAX_CANDIDATES = 25;
const MAX_VALUE = 300;

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("The model's answer was not valid JSON");
  }
}

export function validateClassification(raw: unknown): Classification {
  if (!isObj(raw)) throw new ValidationError("Classification is not an object");
  const { category, confidence, reason } = raw;
  if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) {
    throw new ValidationError("Classification has an unknown category");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new ValidationError("Classification has no confidence");
  }
  return {
    category: category as Category,
    confidence: clamp01(confidence),
    reason: typeof reason === "string" ? reason.slice(0, 300) : "",
  };
}

type Ctx = { source: string; drops: Dropped[]; index: number };

function drop(c: Ctx, field: string, reason: string) {
  c.drops.push({ candidate: c.index, field, reason });
}

/** A `{value, confidence, quote}` field. Returns it only if its quote is in the email. */
function checkText(raw: unknown, field: string, c: Ctx): Field<string> | undefined {
  if (raw === undefined || raw === null) return undefined; // null is how strict-mode providers say "absent"
  if (!isObj(raw) || typeof raw.value !== "string" || typeof raw.confidence !== "number" || typeof raw.quote !== "string") {
    return void drop(c, field, "malformed");
  }
  const value = raw.value.trim();
  if (!value || value.length > MAX_VALUE) return void drop(c, field, "empty or too long");
  if (!Number.isFinite(raw.confidence)) return void drop(c, field, "bad confidence");
  if (!quoteInSource(raw.quote, c.source)) return void drop(c, field, "quote not found in the email");
  return { value, confidence: clamp01(raw.confidence), quote: raw.quote.trim() };
}

function checkNumber(raw: unknown, field: string, c: Ctx): Field<number> | undefined {
  if (raw === undefined || raw === null) return undefined; // null is how strict-mode providers say "absent"
  if (!isObj(raw) || typeof raw.value !== "number" || typeof raw.confidence !== "number" || typeof raw.quote !== "string") {
    return void drop(c, field, "malformed");
  }
  if (!Number.isFinite(raw.value) || !Number.isFinite(raw.confidence)) return void drop(c, field, "not a number");
  if (!quoteInSource(raw.quote, c.source)) return void drop(c, field, "quote not found in the email");
  if (!numberInQuote(raw.value, raw.quote)) return void drop(c, field, "the number is not in its quote");
  return { value: raw.value, confidence: clamp01(raw.confidence), quote: raw.quote.trim() };
}

function checkRate(raw: unknown, c: Ctx): Rate | undefined {
  if (raw === undefined || raw === null) return undefined; // null is how strict-mode providers say "absent"
  if (!isObj(raw) || typeof raw.amount !== "number" || typeof raw.currency !== "string" || typeof raw.confidence !== "number" || typeof raw.quote !== "string") {
    return void drop(c, "rate", "malformed");
  }
  if (!Number.isFinite(raw.amount) || raw.amount <= 0 || !Number.isFinite(raw.confidence)) return void drop(c, "rate", "not a usable amount");
  if (!/^[A-Z]{3}$/.test(raw.currency)) return void drop(c, "rate", "currency is not a three-letter code");
  if (!quoteInSource(raw.quote, c.source)) return void drop(c, "rate", "quote not found in the email");
  if (!numberInQuote(raw.amount, raw.quote)) return void drop(c, "rate", "the amount is not in its quote");
  const unit = typeof raw.unit === "string" && (RATE_UNITS as readonly string[]).includes(raw.unit) ? raw.unit : undefined;
  return { amount: raw.amount, currency: raw.currency, unit, confidence: clamp01(raw.confidence), quote: raw.quote.trim() };
}

function checkRoles(raw: unknown, c: Ctx): PastRole[] | undefined {
  if (raw === undefined || raw === null) return undefined; // null is how strict-mode providers say "absent"
  if (!Array.isArray(raw)) return void drop(c, "past_roles", "malformed");
  const out: PastRole[] = [];
  raw.slice(0, 10).forEach((r, i) => {
    const f = `past_roles[${i}]`;
    if (!isObj(r) || typeof r.confidence !== "number" || typeof r.quote !== "string" || !Number.isFinite(r.confidence)) {
      return drop(c, f, "malformed");
    }
    const title = typeof r.title === "string" ? r.title.trim().slice(0, MAX_VALUE) : "";
    const employer = typeof r.employer === "string" ? r.employer.trim().slice(0, MAX_VALUE) : "";
    if (!title && !employer) return drop(c, f, "no title or employer");
    if (!quoteInSource(r.quote, c.source)) return drop(c, f, "quote not found in the email");
    out.push({
      ...(title && { title }),
      ...(employer && { employer }),
      ...(typeof r.years === "string" && r.years.trim() && { years: r.years.trim().slice(0, 60) }),
      confidence: clamp01(r.confidence),
      quote: r.quote.trim(),
    });
  });
  return out.length ? out : undefined;
}

/** Every word of a name must appear in the email: a name is never invented. */
function nameInSource(name: string, normSource: string): boolean {
  const words = forQuote(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  const sourceWords = new Set(normSource.split(/[^\p{L}\p{N}]+/u));
  return words.length > 0 && words.every((w) => sourceWords.has(w));
}

export type Extraction = { candidates: Candidate[]; dropped: Dropped[] };

/**
 * Checks the model's candidates against the email text. `source` is the exact text the model was shown.
 * Throws only when the answer is not even the expected shape (so the call can be retried); anything wrong
 * with one field or one candidate is dropped and reported in `dropped`.
 */
export function validateExtraction(raw: unknown, source: string): Extraction {
  if (!isObj(raw) || !Array.isArray(raw.candidates)) throw new ValidationError("Extraction has no candidates list");
  const normSource = forQuote(source);
  const dropped: Dropped[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  raw.candidates.slice(0, MAX_CANDIDATES).forEach((rc, index) => {
    const c: Ctx = { source: normSource, drops: dropped, index };
    if (!isObj(rc)) return drop(c, "candidate", "malformed");
    const name = checkText(rc.name, "name", c);
    if (!name) return drop(c, "candidate", "no supported name: the candidate was dropped");
    if (!nameInSource(name.value, normSource)) return drop(c, "name", "the name does not appear in the email: the candidate was dropped");
    const cand: Candidate = { name };
    const set = <K extends keyof Candidate>(k: K, v: Candidate[K] | undefined) => {
      if (v !== undefined) cand[k] = v;
    };
    set("current_title", checkText(rc.current_title, "current_title", c));
    set("current_employer", checkText(rc.current_employer, "current_employer", c));
    set("past_roles", checkRoles(rc.past_roles, c));
    set("geography", checkText(rc.geography, "geography", c));
    set("years_experience", checkNumber(rc.years_experience, "years_experience", c));
    set("rate", checkRate(rc.rate, c));
    set("availability", checkText(rc.availability, "availability", c));
    set("vendor_notes", checkText(rc.vendor_notes, "vendor_notes", c));
    const key = `${forQuote(name.value)}|${forQuote(cand.current_employer?.value ?? "")}`;
    if (seen.has(key)) return drop(c, "candidate", "duplicate of an earlier candidate in the same email");
    seen.add(key);
    candidates.push(cand);
  });
  if (raw.candidates.length > MAX_CANDIDATES) {
    dropped.push({ candidate: null, field: "candidates", reason: `more than ${MAX_CANDIDATES}: the rest were ignored` });
  }
  return { candidates, dropped };
}
