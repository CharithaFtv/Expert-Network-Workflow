import { db, tx } from "../db.ts";
import { htmlToText, normalizeUrl, stripInvisible, tidy, urlsInText, type HtmlInfo, type Link } from "./html.ts";

/**
 * Step 3d: from the stored body of a verified message, produce the text a reader (and later the model)
 * should see: the new content only, with quoted earlier messages and signatures set aside, plus the
 * links in it. Nothing is thrown away: the original body stays as received, and what was removed is
 * kept next to the clean text, so a person can always check what was cut.
 *
 * Rules are conservative on purpose. They cut only well-known markers, never guess at a signature from
 * its look, and never leave a message empty: if cutting would remove everything, nothing is cut.
 * Forwarded mail (subject starting Fw: or Fwd:) is content, so its quoted-looking parts are kept.
 */
export const CLEAN_VERSION = 2;
export const MAX_CLEAN_CHARS = 100_000;
/** After this many failed runs a message is left alone and reported. */
export const MAX_CLEAN_TRIES = 3;

export type CleanLink = { url: string; host: string; text: string; source: "html" | "text"; mismatch: boolean };

export type CleanInfo = HtmlInfo & {
  source: "html" | "text";
  quoteCut: string | null;
  quoteCutSkipped: boolean;
  signatureCut: string | null;
  truncatedOutput: boolean;
};

export type CleanResult = { clean: string; removed: string; links: CleanLink[]; info: CleanInfo };

const isForward = (subject: string) => /^\s*(fw|fwd)\s*:/i.test(subject);

// --- quoted history in text ---------------------------------------------------------------------------

const REPLY_SEPARATOR = /^-{2,}\s*(original message|reply message|original-nachricht|message d'origine)\s*-{2,}$/i;
const ON_WROTE = /^(on|am|le|el|il)\s.{5,300}(wrote|schrieb|a écrit|escribió|ha scritto)\s*:\s*$/i;
const HEADER_FROM = /^(from|von|de|da)\s*:\s*\S/i;
const HEADER_SENT = /^(sent|date|gesendet|envoyé|enviado|inviato)\s*:/i;
const HEADER_SUBJECT = /^(subject|betreff|objet|asunto|oggetto)\s*:/i;

/** Is there the start of quoted earlier mail at this line? Returns the marker name. */
function replyMarker(lines: string[], i: number): string | null {
  const line = lines[i];
  if (REPLY_SEPARATOR.test(line)) return "original message";
  if (/^_{20,}$/.test(line)) {
    const next = lines.slice(i + 1, i + 4).find((l) => l.trim());
    if (next && HEADER_FROM.test(next)) return "outlook separator";
  }
  // "On <date>, <name> wrote:" often wraps onto a second line.
  if (/^(on|am|le|el|il)\s/i.test(line)) {
    const next = lines[i + 1]?.trim() ?? "";
    if (ON_WROTE.test(line) || ON_WROTE.test(`${line} ${next}`)) return "on wrote";
  }
  if (HEADER_FROM.test(line)) {
    const block = lines.slice(i + 1, i + 7);
    if (block.some((l) => HEADER_SENT.test(l)) && block.some((l) => HEADER_SUBJECT.test(l))) return "header block";
  }
  return null;
}

type Split = { clean: string; quoted: string; marker: string | null; skipped: boolean };

function splitQuoted(text: string, forward: boolean): Split {
  if (forward) return { clean: text, quoted: "", marker: null, skipped: false };
  const lines = text.split("\n");
  let cut = -1;
  let marker: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = replyMarker(lines, i);
    if (m) {
      cut = i;
      marker = m;
      break;
    }
  }
  const head = cut === -1 ? lines : lines.slice(0, cut);
  const tail = cut === -1 ? [] : lines.slice(cut);
  // "> quoted" lines above the cut are quoted history too; anything else, such as an inline answer, stays.
  const keep: string[] = [];
  const quotedLines: string[] = [];
  for (const l of head) (/^\s*>/.test(l) ? quotedLines : keep).push(l);
  if (quotedLines.length && !marker) marker = "quote marks";
  const clean = tidy(keep.join("\n"));
  if (!/\S/.test(clean)) {
    // The message is nothing but quoted-looking text (for example a pasted profile): keep it all.
    return { clean: text, quoted: "", marker: null, skipped: marker !== null };
  }
  return { clean, quoted: tidy([...quotedLines, ...tail].join("\n")), marker, skipped: false };
}

// --- signatures ---------------------------------------------------------------------------------------

const MOBILE_FOOTER =
  /^(sent from my (iphone|ipad|android|samsung|mobile|blackberry|galaxy)|sent from (outlook|mail|yahoo mail|gmail) (for|on) (ios|android|mac|windows)|get outlook for (ios|android|mac|windows)|sent via .+)/i;

const PROFILE_LIKE = /[$£€]\s*\d|\d\s*(usd|gbp|eur)\b|\b(rate|per hour|an hour|\/\s*h(ou)?r|years? (of )?experience|expert\s*\d|profile\s*\d)\b/i;

/** Cuts a signature only where it is marked: the "-- " delimiter or a mobile app footer near the end. */
function splitSignature(text: string): { clean: string; signature: string; marker: string | null } {
  const lines = text.split("\n");
  const from = Math.max(1, lines.length - 25); // never the first line, so a message is never emptied
  for (let i = from; i < lines.length; i++) {
    const l = lines[i].trim();
    // Lines are already trimmed, so a "--" cannot be told from a vendor's separator between profiles. Cut only
    // where what follows looks like a signature: short, and with no rate or experience in it.
    const tail = lines.slice(i + 1).join("\n");
    if (l === "--" && lines.length - i <= 13 && !PROFILE_LIKE.test(tail)) return { clean: tidy(lines.slice(0, i).join("\n")), signature: tidy(lines.slice(i + 1).join("\n")), marker: "delimiter" };
    if (MOBILE_FOOTER.test(l) && lines.length - i <= 5) {
      return { clean: tidy(lines.slice(0, i).join("\n")), signature: tidy(lines.slice(i).join("\n")), marker: "mobile footer" };
    }
  }
  return { clean: text, signature: "", marker: null };
}

// --- links --------------------------------------------------------------------------------------------

/** Does the visible text of a link name a different site than the link goes to? */
export function textMismatch(text: string, host: string): boolean {
  const m = text.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i);
  if (!m) return false;
  const shown = m[1].toLowerCase().replace(/^www\./, "");
  const real = host.toLowerCase().replace(/^www\./, "");
  return !(shown === real || shown.endsWith(`.${real}`) || real.endsWith(`.${shown}`));
}

function toCleanLinks(anchors: Link[], textLinks: Link[]): CleanLink[] {
  const out = new Map<string, CleanLink>();
  const add = (l: Link, source: "html" | "text") => {
    const u = normalizeUrl(l.url);
    if (!u || out.has(u.toString())) return;
    out.set(u.toString(), {
      url: u.toString(),
      host: u.hostname.toLowerCase(),
      text: l.text,
      source,
      mismatch: textMismatch(l.text, u.hostname),
    });
  };
  for (const l of anchors) add(l, "html");
  for (const l of textLinks) add(l, "text");
  return [...out.values()];
}

// --- the whole thing ----------------------------------------------------------------------------------

export function cleanMessage(input: { bodyType: "html" | "text"; body: string; subject: string }): CleanResult {
  const forward = isForward(input.subject);
  let text: string;
  let htmlQuoted = "";
  let anchors: Link[] = [];
  let base: HtmlInfo = { hiddenChars: 0, quoteMarker: null, truncatedInput: false, nodeLimitHit: false };
  if (input.bodyType === "html") {
    const r = htmlToText(input.body, { isForward: forward });
    text = r.clean;
    htmlQuoted = r.quoted;
    anchors = r.links;
    base = r.info;
  } else {
    const body = input.body.length > 2_000_000 ? input.body.slice(0, 2_000_000) : input.body;
    base.truncatedInput = body.length !== input.body.length;
    text = tidy(body);
  }

  const q = splitQuoted(text, forward);
  const sig = splitSignature(q.clean);
  let clean = sig.clean;
  let truncatedOutput = false;
  if (clean.length > MAX_CLEAN_CHARS) {
    clean = `${clean.slice(0, MAX_CLEAN_CHARS)}\n[truncated]`;
    truncatedOutput = true;
  }

  // A link whose visible text was cut away with the signature or quoted history is not part of the message.
  // (A link with no text, such as a button image, cannot be checked and is kept for the reader to judge.)
  const shown = clean.replace(/\s+/g, " ");
  anchors = anchors.filter((a) => !a.text || shown.includes(a.text));

  const removedParts: string[] = [];
  const quoted = [htmlQuoted, q.quoted].filter(Boolean).join("\n\n");
  if (quoted) removedParts.push(`[quoted history]\n${quoted}`);
  if (sig.signature) removedParts.push(`[signature]\n${sig.signature}`);

  return {
    clean,
    removed: removedParts.join("\n\n"),
    links: toCleanLinks(anchors, urlsInText(clean)),
    info: {
      ...base,
      source: input.bodyType,
      quoteCut: base.quoteMarker ?? q.marker,
      quoteCutSkipped: q.skipped,
      signatureCut: sig.marker,
      truncatedOutput,
    },
  };
}

// --- the database step --------------------------------------------------------------------------------

export type CleanCounts = { messages: number; links: number; failed: number; errors: string[]; abandoned: number };

/**
 * Cleans every Matched message that has not been cleaned yet, or was cleaned by an older version of the
 * rules (messages that are not verified are never processed). One message at a time, its text and links
 * written together under a row lock, and only if it is still Matched and unpurged. A message the cleaner
 * fails on is retried a few times, then reported.
 */
export async function cleanPending(limit = 200): Promise<CleanCounts> {
  const counts: CleanCounts = { messages: 0, links: 0, failed: 0, errors: [], abandoned: 0 };
  const rows = await db.query<{ id: number; body_type: "html" | "text"; body: string; subject: string }>(
    `SELECT id, body_type, body, subject FROM inbound_messages
     WHERE status = 'Matched' AND purged_at IS NULL AND clean_attempts < $2
       AND (cleaned_at IS NULL OR clean_version < $3)
     ORDER BY clean_attempts, id LIMIT $1`,
    [limit, MAX_CLEAN_TRIES, CLEAN_VERSION],
  );
  for (const m of rows) {
    try {
      const r = cleanMessage({ bodyType: m.body_type, body: m.body, subject: m.subject });
      const now = new Date().toISOString();
      const written = await tx(async (q) => {
        const [cur] = await q.query<{ status: string; purged_at: string | null; done: string | null; version: number | null }>(
          "SELECT status, purged_at, cleaned_at AS done, clean_version AS version FROM inbound_messages WHERE id = $1 FOR UPDATE",
          [m.id],
        );
        if (!cur || cur.status !== "Matched" || cur.purged_at) return false;
        if (cur.done && (cur.version ?? 0) >= CLEAN_VERSION) return false; // someone already did it
        // A re-clean replaces what the older rules produced, links included. What the model read was the old
        // text, so its result goes too and is made again (unless a person has already confirmed one).
        await q.query("DELETE FROM inbound_links WHERE message_id = $1", [m.id]);
        await q.query(
          `DELETE FROM extractions e WHERE e.message_id = $1 AND NOT EXISTS
             (SELECT 1 FROM extracted_candidates c WHERE c.extraction_id = e.id AND c.review_status = 'Confirmed')`,
          [m.id],
        );
        await q.query("UPDATE inbound_messages SET extraction_attempts = 0, extraction_error = NULL WHERE id = $1", [m.id]);
        await q.query(
          `UPDATE inbound_messages
           SET text_clean = $2, text_removed = $3, clean_info = $4, cleaned_at = $5, clean_version = $6, clean_error = NULL
           WHERE id = $1`,
          [m.id, r.clean, r.removed || null, JSON.stringify(r.info), now, CLEAN_VERSION],
        );
        for (const l of r.links) {
          await q.query(
            `INSERT INTO inbound_links (message_id, url, host, link_text, source, text_mismatch, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (message_id, url) DO NOTHING`,
            [m.id, l.url, l.host, stripInvisible(l.text), l.source, l.mismatch, now],
          );
        }
        return true;
      });
      if (!written) continue;
      counts.messages++;
      counts.links += r.links.length;
    } catch (e) {
      counts.failed++;
      const reason = (e as Error).message;
      if (counts.errors.length < 3) counts.errors.push(`message ${m.id}: ${reason}`);
      await db
        .query("UPDATE inbound_messages SET clean_attempts = clean_attempts + 1, clean_error = $2 WHERE id = $1", [
          m.id,
          reason.slice(0, 500),
        ])
        .catch(() => {});
    }
  }
  const [gone] = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM inbound_messages
     WHERE status = 'Matched' AND purged_at IS NULL AND clean_attempts >= $1
       AND (cleaned_at IS NULL OR clean_version < $2)`,
    [MAX_CLEAN_TRIES, CLEAN_VERSION],
  );
  counts.abandoned = gone.n;
  return counts;
}
