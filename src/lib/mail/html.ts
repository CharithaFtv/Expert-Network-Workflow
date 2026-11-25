/**
 * Step 3d: turn the HTML body of an email into plain text, safely.
 *
 * The HTML is only ever read, never rendered or run: no script, style or markup reaches the output. The
 * parser is deliberately small and tolerant (emails are messy), bounded in size, depth and node count,
 * and has no dependencies. What it returns:
 *   - `clean`   the new content of the message
 *   - `quoted`  earlier messages quoted underneath it (kept, not thrown away)
 *   - `links`   the http(s) links in the new content
 *   - `info`    what was removed or limited, for the audit trail
 */
export type Link = { url: string; text: string };

export type HtmlResult = {
  clean: string;
  quoted: string;
  links: Link[];
  info: HtmlInfo;
};

export type HtmlInfo = {
  /** Characters of text that a reader could not see (display:none, zero font size, ...). */
  hiddenChars: number;
  /** The quoted history was found by a marker in the markup. */
  quoteMarker: string | null;
  truncatedInput: boolean;
  nodeLimitHit: boolean;
};

export const MAX_INPUT_CHARS = 2_000_000;
const MAX_NODES = 200_000;
const MAX_DEPTH = 256;

type El = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = El | string;
const isEl = (n: Node): n is El => typeof n !== "string";

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr", "param"]);
/** Elements whose content is never part of what a person reads. */
const SKIP = new Set([
  "script", "style", "head", "title", "meta", "link", "noscript", "template", "svg", "canvas", "iframe", "object",
  "embed", "img", "video", "audio", "map", "textarea", "select", "option", "datalist",
]);
/** Elements whose content is raw text up to their closing tag (no markup inside). */
const RAW = new Set(["script", "style", "textarea", "title"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "center", "dd", "details", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "li", "main",
  "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const PARAGRAPH = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "pre", "dl"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", bull: "•",
  middot: "·", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", deg: "°", plusmn: "±", times: "×",
  divide: "÷", laquo: "«", raquo: "»", iexcl: "¡", iquest: "¿", para: "¶", frac12: "½", frac14: "¼", frac34: "¾",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", ccedil: "ç", egrave: "è", eacute: "é",
  ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó",
  ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
  szlig: "ß", Agrave: "À", Aacute: "Á", Acirc: "Â", Auml: "Ä", Aring: "Å", Ccedil: "Ç", Egrave: "È", Eacute: "É",
  Ntilde: "Ñ", Ouml: "Ö", Uuml: "Ü", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍", shy: "",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,8}));/g, (all, dec, hex, name) => {
    if (name) return ENTITIES[name] ?? all;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
    return String.fromCodePoint(cp);
  });
}

/** Reads markup into a small tree. Tolerant: unknown or broken markup never throws, it is just text or dropped. */
function parse(html: string, info: HtmlInfo): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  let nodes = 0;
  const top = () => stack[stack.length - 1];
  const addText = (t: string) => {
    if (!t || info.nodeLimitHit) return;
    if (++nodes > MAX_NODES) return void (info.nodeLimitHit = true);
    top().children.push(t);
  };
  const closeTo = (...tags: string[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (tags.includes(stack[i].tag)) return void (stack.length = i);
      if (["table", "ul", "ol", "dl", "body"].includes(stack[i].tag)) return; // do not close past a boundary
    }
  };

  let i = 0;
  const n = html.length;
  while (i < n && !info.nodeLimitHit) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3; // comments are dropped (a dangling one swallows the rest, like a browser)
      continue;
    }
    if (html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      addText(html.slice(i + 9, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const close = html[i + 1] === "/";
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 60));
    if (!m) {
      addText("<"); // a lone "<" is just a character
      i++;
      continue;
    }
    const tag = m[1].toLowerCase();
    // Read to the end of the tag, honouring quotes around attribute values.
    let j = i + m[0].length;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < n) {
      const c = html[j];
      if (c === ">") {
        j++;
        break;
      }
      if (c === "/" && html[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      if (/\s|\//.test(c)) {
        j++;
        continue;
      }
      const am = /^([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(html.slice(j, j + 4000));
      if (!am) {
        j++;
        continue;
      }
      if (!close) attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
      j += am[0].length;
    }
    i = j;

    if (close) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    // Implied end tags, enough for the structure emails actually use.
    if (tag === "p") closeTo("p");
    else if (tag === "li") closeTo("li");
    else if (tag === "tr") closeTo("tr");
    else if (tag === "td" || tag === "th") closeTo("td", "th");
    else if (tag === "dt" || tag === "dd") closeTo("dt", "dd");

    if (++nodes > MAX_NODES) {
      info.nodeLimitHit = true;
      break;
    }
    const el: El = { tag, attrs, children: [] };
    top().children.push(el);
    if (RAW.has(tag) && !selfClose) {
      const endRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const em = endRe.exec(rest);
      i += em ? em.index + em[0].length : rest.length; // the raw content is dropped, it is never text
      continue;
    }
    if (VOID.has(tag) || selfClose) continue;
    if (stack.length >= MAX_DEPTH) {
      // Too deep to keep the structure. Flattening would turn the contents into siblings and could expose
      // text from a hidden or quoted ancestor, so stop here: what follows is not read.
      info.nodeLimitHit = true;
      break;
    }
    stack.push(el);
  }
  return root;
}

const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|opacity\s*:\s*0(?:\.0*)?\s*(?:;|!|$)|font-size\s*:\s*0(?:\.0*)?(?:px|pt|em|rem|%)?\s*(?:;|!|$)|(?:max-)?height\s*:\s*0(?:px|pt)?\s*(?:;|!|$)[^"]*overflow\s*:\s*hidden/i;

const isHidden = (el: El) =>
  "hidden" in el.attrs || (el.attrs.style !== undefined && HIDDEN_STYLE.test(el.attrs.style));

/** A marker after which everything else in the document is quoted history (Outlook adds one). */
const OUTLOOK_MARKER = /(^|_)(divRplyFwdMsg|appendonsend)$/i;
const QUOTE_CLASS = /\b(gmail_quote|yahoo_quoted|moz-cite-prefix|OutlookMessageHeader)\b/i;

const textLength = (n: Node): number =>
  isEl(n) ? (SKIP.has(n.tag) ? 0 : n.children.reduce((a, c) => a + textLength(c), 0)) : n.trim().length;

export function htmlToText(html: string, opts: { isForward?: boolean } = {}): HtmlResult {
  const info: HtmlInfo = { hiddenChars: 0, quoteMarker: null, truncatedInput: false, nodeLimitHit: false };
  if (html.length > MAX_INPUT_CHARS) {
    html = html.slice(0, MAX_INPUT_CHARS);
    info.truncatedInput = true;
  }
  const root = parse(html, info);

  let clean = "";
  let quoted = "";
  let afterMarker = false; // everything from an Outlook marker on is quoted
  const links: Link[] = [];

  /** Renders one subtree to text. `inQuote` decides which buffer collects it. */
  const render = (node: Node, inQuote: boolean, pre: boolean): string => {
    if (!isEl(node)) {
      return pre ? decodeEntities(node) : decodeEntities(node).replace(/[ \t\r\n\f]+/g, " ");
    }
    if (SKIP.has(node.tag)) return "";
    if (isHidden(node)) {
      info.hiddenChars += textLength(node);
      return "";
    }
    const isBlock = BLOCK.has(node.tag);
    const nowPre = pre || node.tag === "pre";
    let inner = "";
    for (const c of node.children) {
      if (isEl(c) && !opts.isForward) {
        const marker = quoteMarkerOf(c);
        if (marker && !inQuote) {
          // The element's text goes to the quoted buffer instead of the clean one.
          info.quoteMarker ??= marker;
          if (OUTLOOK_MARKER.test(c.attrs.id ?? "") || /OutlookMessageHeader/i.test(c.attrs.class ?? "")) {
            afterMarker = true;
          }
          quoted += render(c, true, nowPre);
          continue;
        }
      }
      if (afterMarker && !inQuote && !opts.isForward) {
        quoted += render(c, true, nowPre);
        continue;
      }
      inner += render(c, inQuote, nowPre);
    }
    // Block boundaries are written as markers, not newlines, so that neighbouring boundaries merge: a run of
    // markers becomes one line break, or a blank line if any of them was a paragraph boundary. Without this,
    // email that uses one <div> per line would come out with a blank line between every line.
    if (node.tag === "br") return "\n";
    if (node.tag === "hr") return SOFT;
    if (node.tag === "a" && node.attrs.href !== undefined && !inQuote) collectLink(node.attrs.href, inner, links);
    if (node.tag === "li") return `${SOFT}- ${inner.trim()}`; // the list around it adds the closing break
    if (node.tag === "td" || node.tag === "th") return `${inner.trim()} | `;
    if (node.tag === "tr") return `${SOFT}${inner.replace(/\s*\|\s*$/, "").trim()}`; // the table adds the closing break
    if (isBlock) {
      const sep = PARAGRAPH.has(node.tag) ? PARA : SOFT;
      return `${sep}${inner}${sep}`;
    }
    return inner;
  };

  const quoteMarkerOf = (el: El): string | null => {
    if (el.tag === "blockquote") return "blockquote";
    if (OUTLOOK_MARKER.test(el.attrs.id ?? "")) return "outlook";
    const cls = QUOTE_CLASS.exec(el.attrs.class ?? "");
    return cls ? cls[1].toLowerCase() : null;
  };

  clean = render(root, false, false);
  return { clean: tidy(breaks(clean)), quoted: tidy(breaks(quoted)), links: dedupeLinks(links), info };
}

const SOFT = "\u0001";
const PARA = "\u0002";
/** Turns runs of block-boundary markers into real line breaks. */
const breaks = (s: string) => s.replace(/[\u0001\u0002]+/g, (run) => (run.includes(PARA) ? "\n\n" : "\n"));

/** Collapses blank lines and trailing spaces, and removes characters that hide or reorder text. */
export function tidy(text: string): string {
  return stripInvisible(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Compatibility-normalises the text (fullwidth and lookalike forms become plain ones) and removes
 * zero-width, bidirectional-override and control characters, which can hide words or reorder what a
 * reader sees. Newlines and tabs stay.
 */
export function stripInvisible(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­؜᠎​‎‏‪-‮⁠-⁯﻿￹-￻]/g, "");
}

const MAX_LINKS = 200;
const MAX_URL = 2048;

/** A link we keep: http or https, with a host, no embedded credentials. */
export function normalizeUrl(raw: string): URL | null {
  const trimmed = stripInvisible(raw).trim();
  if (!trimmed || trimmed.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (u.username || u.password) return null; // "https://vendor.com@evil.com" tricks
  return u;
}

function collectLink(href: string, innerText: string, links: Link[]) {
  if (links.length >= MAX_LINKS) return;
  const u = normalizeUrl(decodeEntities(href));
  if (!u) return;
  // Block boundaries inside the link text are internal markers: make them spaces, as the clean text does.
  links.push({ url: u.toString(), text: tidy(innerText.replace(/[\u0001\u0002]/g, " ")).replace(/\s+/g, " ").slice(0, 300) });
}

function dedupeLinks(links: Link[]): Link[] {
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}

/** URLs written out in plain text, without trailing punctuation. */
export function urlsInText(text: string): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`\]\[(){}]+/gi)) {
    if (out.length >= MAX_LINKS) break;
    const u = normalizeUrl(m[0].replace(/[.,;:!?)\]}>'"]+$/, ""));
    if (u) out.push({ url: u.toString(), text: "" });
  }
  return dedupeLinks(out);
}
