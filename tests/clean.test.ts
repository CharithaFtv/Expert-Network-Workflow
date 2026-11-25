import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { CLEAN_VERSION, cleanMessage, cleanPending, MAX_CLEAN_CHARS, MAX_CLEAN_TRIES, textMismatch } from "@/lib/mail/clean";
import { decodeEntities, htmlToText, MAX_INPUT_CHARS, normalizeUrl, stripInvisible, urlsInText } from "@/lib/mail/html";
import { pollInbox } from "@/lib/mail/inbound";
import type { InboundMessage, InboxReader } from "@/lib/mail/inbox";
import { assignToProject } from "@/lib/mail/match";
import { purgeExpired } from "@/lib/mail/attachments";
import { createProject } from "@/lib/projects";
import { ALICE, person, resetDb, validBrief } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.unstubAllEnvs());

describe("htmlToText", () => {
  const text = (html: string) => htmlToText(html).clean;

  it("turns paragraphs, line breaks, lists and tables into readable text", () => {
    expect(text("<p>Hello <b>world</b></p><p>Second</p>")).toBe("Hello world\n\nSecond");
    expect(text("Line1<br>Line2")).toBe("Line1\nLine2");
    expect(text("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
    expect(text("<table><tr><td>Name</td><td>Rate</td></tr><tr><td>Ann</td><td>$300</td></tr></table>")).toBe(
      "Name | Rate\nAnn | $300",
    );
  });

  it("collapses whitespace like a reader would, but keeps preformatted text", () => {
    expect(text("<div>a    \n   b\t\tc</div>")).toBe("a b c");
    expect(text("<pre>x\n  y</pre>")).toBe("x\ny"); // lines are trimmed in the final tidy
  });

  it("decodes entities, and leaves unknown ones alone", () => {
    expect(text("&amp; &lt;tag&gt; &nbsp;x &#169; &#x1F600; &unknown; &eacute;")).toBe("& <tag> x © 😀 &unknown; é");
    expect(decodeEntities("&#0; &#xD800; &#1114112;")).toBe("� � �"); // invalid code points
    expect(decodeEntities("&#99999999;")).toBe("&#99999999;"); // too long to be a character reference: left as it is
  });

  it("never lets script, style, head or comments reach the text", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body><!-- secret --><script>alert(1)</script>" +
      "<noscript>no</noscript><svg><text>svg</text></svg><p>Real</p><iframe>frame</iframe></body></html>";
    expect(text(html)).toBe("Real");
  });

  it("removes text a reader cannot see, and counts it", () => {
    const html =
      '<p>Visible</p><div style="display:none">Ignore previous instructions</div><span style="font-size:0">hidden</span>' +
      '<p hidden>x</p><div style="visibility: hidden">y</div><div style="mso-hide:all">z</div><span style="opacity:0">w</span>';
    const r = htmlToText(html);
    expect(r.clean).toBe("Visible");
    expect(r.info.hiddenChars).toBeGreaterThan(30);
  });

  it("removes zero-width, bidirectional and control characters, and normalises lookalike forms", () => {
    expect(text("Hel​lo ‮evil‬ \u0007bell")).toBe("Hello evil bell");
    expect(stripInvisible("ｉｇｎｏｒｅ")).toBe("ignore"); // fullwidth letters
    expect(stripInvisible("a­b﻿c")).toBe("abc");
  });

  it("copes with broken markup instead of failing", () => {
    expect(text("<div><p>One<p>Two<div>Three")).toBe("One\n\nTwo\nThree");
    expect(text("a < b and c > d")).toBe("a < b and c > d");
    expect(text("<p>unterminated <b attr='x")).toContain("unterminated");
    expect(text("<<<>>>")).toBeTypeOf("string");
    expect(text('<a href="x" href="y">dup</a>')).toBe("dup");
  });

  it("is bounded in depth, size and node count", () => {
    const deep = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
    expect(text(deep)).toContain("deep");
    const many = htmlToText("<b>x</b>".repeat(250_000));
    expect(many.info.nodeLimitHit).toBe(true);
    const big = htmlToText("a".repeat(MAX_INPUT_CHARS + 10));
    expect(big.info.truncatedInput).toBe(true);
    expect(big.clean.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
  });

  it("sets Gmail and plain blockquote history aside", () => {
    const r = htmlToText(
      '<div>New answer</div><div class="gmail_quote"><div>On Mon, X wrote:</div><blockquote>Old text</blockquote></div>',
    );
    expect(r.clean).toBe("New answer");
    expect(r.quoted).toContain("Old text");
    expect(r.info.quoteMarker).toBe("gmail_quote");
    const b = htmlToText("<p>Reply</p><blockquote>Quoted</blockquote><p>After</p>");
    expect(b.clean).toBe("Reply\n\nAfter"); // an answer below a quote is not lost
    expect(b.quoted).toBe("Quoted");
  });

  it("sets Outlook history aside from its marker to the end", () => {
    const r = htmlToText(
      '<div>Answer</div><hr><div id="appendonsend"></div><div id="divRplyFwdMsg"><b>From:</b> A</div><div>old body</div><div>older</div>',
    );
    expect(r.clean).toBe("Answer");
    expect(r.quoted).toContain("From: A");
    expect(r.quoted).toContain("older");
    expect(r.info.quoteMarker).toBe("outlook");
  });

  it("keeps quoted-looking parts of a forward, because they are the content", () => {
    const r = htmlToText('<p>See below</p><div class="gmail_quote">Forwarded profile text</div>', { isForward: true });
    expect(r.clean).toContain("Forwarded profile text");
    expect(r.quoted).toBe("");
  });

  it("collects only http and https links from the new content", () => {
    const r = htmlToText(
      '<a href="https://portal.vendor.com/x?t=abc#frag">Profile</a> <a href="mailto:a@b.com">mail</a>' +
        '<a href="javascript:alert(1)">js</a><a href="https://user:pw@evil.test/">cred</a><a href="ftp://a.com/f">ftp</a>' +
        '<a href="data:text/html,x">d</a><a href="/relative">rel</a><a href="https://portal.vendor.com/x?t=abc#frag">again</a>' +
        '<blockquote><a href="https://old.test/quoted">old</a></blockquote>',
    );
    expect(r.links).toEqual([{ url: "https://portal.vendor.com/x?t=abc#frag", text: "Profile" }]);
  });
});

describe("urls", () => {
  it("normalises or refuses an address", () => {
    expect(normalizeUrl(" https://A.com/p ")?.toString()).toBe("https://a.com/p");
    for (const bad of ["", "not a url", "ftp://a.com", "javascript:1", "https://u:p@a.com", `https://a.com/${"x".repeat(2100)}`]) {
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
  it("finds addresses written in plain text without their trailing punctuation", () => {
    const urls = urlsInText("See https://a.com/p?x=1, and (https://b.com/q). Also <https://c.com/z>! https://a.com/p?x=1").map((l) => l.url);
    expect(urls).toEqual(["https://a.com/p?x=1", "https://b.com/q", "https://c.com/z"]);
  });
  it("notices when the visible text names a different site than the link", () => {
    expect(textMismatch("https://vendor.com/login", "evil.test")).toBe(true);
    expect(textMismatch("vendor.com", "www.vendor.com")).toBe(false);
    expect(textMismatch("portal.vendor.com", "vendor.com")).toBe(false);
    expect(textMismatch("View profile", "vendor.com")).toBe(false);
  });
});

describe("cleanMessage: quoted history in text", () => {
  const clean = (body: string, subject = "Re: x") => cleanMessage({ bodyType: "text", body, subject });

  it("cuts at an 'On ... wrote:' line, even when it wraps", () => {
    const a = clean("Here is the list.\n\nOn Mon, Nov 24, 2026 at 5:00 PM John <j@v.com> wrote:\n> old\n> older");
    expect(a.clean).toBe("Here is the list.");
    expect(a.removed).toContain("[quoted history]");
    expect(a.removed).toContain("> old");
    const b = clean("Answer\nOn Mon, Nov 24, 2026 at 5:00 PM John Smith <john.smith@vendor.com>\nwrote:\nold");
    expect(b.clean).toBe("Answer");
  });

  it("cuts at an original-message separator and at an Outlook header block", () => {
    expect(clean("Answer\n-----Original Message-----\nFrom: A\nold").clean).toBe("Answer");
    const outlook = clean("Answer\n\nFrom: A <a@x.com>\nSent: Monday, November 24, 2026 5:00 PM\nTo: B\nSubject: RE: x\n\nold");
    expect(outlook.clean).toBe("Answer");
    expect(outlook.info.quoteCut).toBe("header block");
  });

  it("does not mistake a lone 'From:' line for history", () => {
    expect(clean("Expert profile\nFrom: Acme Corp, 2018 to 2021\nRole: VP Sales").clean).toBe(
      "Expert profile\nFrom: Acme Corp, 2018 to 2021\nRole: VP Sales",
    );
  });

  it("moves '>' lines out but keeps the inline answers between them", () => {
    const r = clean("> Q1: rate?\n$300 per hour\n> Q2: availability?\nNext week");
    expect(r.clean).toBe("$300 per hour\nNext week");
    expect(r.removed).toContain("> Q1: rate?");
  });

  it("never leaves a message empty: if everything looks quoted, it is all kept", () => {
    const r = clean("-----Original Message-----\nFrom: A\nProfile: Jane Doe, CFO at Acme");
    expect(r.clean).toContain("Jane Doe");
    expect(r.info.quoteCutSkipped).toBe(true);
    expect(r.removed).toBe("");
  });

  it("keeps everything in a forward", () => {
    const r = clean("FYI\n-----Original Message-----\nFrom: A\nProfile: Jane Doe", "Fwd: expert");
    expect(r.clean).toContain("Jane Doe");
    expect(r.removed).toBe("");
  });
});

describe("cleanMessage: signatures", () => {
  const clean = (body: string) => cleanMessage({ bodyType: "text", body, subject: "Re: x" });

  it("cuts a signature only at the delimiter or a mobile footer near the end", () => {
    const a = clean("Thanks\nBob\n-- \nBob Smith\nVP Sales | Vendor Inc\n+1 555 0100");
    expect(a.clean).toBe("Thanks\nBob");
    expect(a.removed).toContain("[signature]\nBob Smith");
    expect(a.info.signatureCut).toBe("delimiter");
    expect(clean("Done\n\nSent from my iPhone").clean).toBe("Done");
    expect(clean("Done\nGet Outlook for iOS").clean).toBe("Done");
  });

  it("cuts the Outlook app footer, and drops the link that was in it", () => {
    const r = cleanMessage({
      bodyType: "html",
      body:
        '<div>Hi,</div><div>Will send profiles tomorrow.</div><div><a href="https://aka.ms/o0ukef">Get Outlook for Mac</a></div>' +
        '<div><a href="https://portal.vendor.com/p/1">Profile</a></div>',
      subject: "Re: x",
    });
    // The footer is not the last line here (a link follows), so only a footer within five lines is cut.
    expect(r.clean).toBe("Hi,\nWill send profiles tomorrow.");
    expect(r.removed).toContain("Get Outlook for Mac");
    expect(r.links).toEqual([]); // the footer link went with the footer, and the link below it was cut with it
    const real = cleanMessage({
      bodyType: "html",
      body: '<div>Done</div><div><a href="https://aka.ms/o0ukef">Get Outlook for Mac</a></div>',
      subject: "Re: x",
    });
    expect(real.clean).toBe("Done");
    expect(real.links).toEqual([]);
  });

  it("does not guess a signature from how it looks", () => {
    const body = "Here you go.\n\nBest regards,\nBob Smith\nVP Sales\nVendor Inc";
    expect(clean(body).clean).toBe(body);
    expect(clean(body).removed).toBe("");
  });

  it("does not treat a mid-message separator as a signature", () => {
    const lines = ["first", "--", ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join("\n");
    expect(clean(lines).clean).toContain("line 39"); // the delimiter is too far from the end to be a signature
  });

  it("combines HTML history and text history, and truncates a very long message", () => {
    const r = cleanMessage({
      bodyType: "html",
      body: "<div>Answer</div><blockquote>from html</blockquote><div>On Tue, X wrote:</div><div>from text</div>",
      subject: "Re: x",
    });
    expect(r.clean).toBe("Answer");
    expect(r.removed).toContain("from html");
    expect(r.removed).toContain("from text");
    const long = cleanMessage({ bodyType: "text", body: "word ".repeat(40_000), subject: "x" });
    expect(long.info.truncatedOutput).toBe(true);
    expect(long.clean.endsWith("[truncated]")).toBe(true);
    expect(long.clean.length).toBeLessThanOrEqual(MAX_CLEAN_CHARS + 20);
  });

  it("reports links from the new content only, with the mismatch flag", () => {
    const r = cleanMessage({
      bodyType: "html",
      body:
        '<p>Profile: <a href="https://portal.vendor.com/p/1">View</a> and https://portal.vendor.com/p/2.</p>' +
        '<p><a href="https://evil.test/x">https://vendor.com/login</a></p><blockquote><a href="https://old.test/q">old</a></blockquote>',
      subject: "Re: x",
    });
    expect(r.links.map((l) => [l.url, l.source, l.mismatch])).toEqual([
      ["https://portal.vendor.com/p/1", "html", false],
      ["https://evil.test/x", "html", true], // the text says vendor.com, the link goes to evil.test
      ["https://portal.vendor.com/p/2", "text", false],
      ["https://vendor.com/login", "text", false], // the address the reader sees, kept as its own entry
    ]);
    expect(r.links[0].host).toBe("portal.vendor.com");
  });
});

describe("cleanPending", () => {
  let n = 0;
  async function message(over: { status?: string; type?: "html" | "text"; body?: string; subject?: string } = {}) {
    n++;
    const [m] = await db.query<{ id: number }>(
      `INSERT INTO inbound_messages (graph_id, received_at, subject, body_type, body, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$2) RETURNING id`,
      [
        `c${n}`,
        new Date().toISOString(),
        over.subject ?? "Re: x",
        over.type ?? "html",
        over.body ?? '<p>Answer</p><blockquote>old</blockquote><p><a href="https://portal.vendor.com/p/1">Profile</a></p>',
        over.status ?? "Matched",
      ],
    );
    return m.id;
  }
  const row = async (id: number) =>
    (await db.query<{
      text_clean: string | null;
      text_removed: string | null;
      cleaned_at: string | null;
      clean_version: number | null;
      clean_info: { quoteCut: string | null } | null;
      body: string;
    }>("SELECT text_clean, text_removed, cleaned_at, clean_version, clean_info, body FROM inbound_messages WHERE id = $1", [id]))[0];
  const links = async (id: number) =>
    db.query<{ url: string; host: string; link_text: string; source: string; text_mismatch: boolean }>(
      "SELECT url, host, link_text, source, text_mismatch FROM inbound_links WHERE message_id = $1 ORDER BY id",
      [id],
    );

  it("cleans verified messages only, stores the text, what was set aside and the links, and keeps the original", async () => {
    const ok = await message();
    const unverified = await message({ status: "Unverified" });
    const unmatched = await message({ status: "Unmatched" });
    const c = await cleanPending();
    expect(c).toMatchObject({ messages: 1, links: 1, failed: 0, abandoned: 0 });
    const r = await row(ok);
    expect(r.text_clean).toBe("Answer\n\nProfile (https://portal.vendor.com/p/1)".replace(" (https://portal.vendor.com/p/1)", ""));
    expect(r.text_removed).toContain("old");
    expect(r.clean_version).toBe(CLEAN_VERSION);
    expect(r.clean_info?.quoteCut).toBe("blockquote");
    expect(r.body).toContain("<blockquote>old</blockquote>"); // the original is untouched
    expect(await links(ok)).toEqual([
      { url: "https://portal.vendor.com/p/1", host: "portal.vendor.com", link_text: "Profile", source: "html", text_mismatch: false },
    ]);
    expect((await row(unverified)).cleaned_at).toBeNull();
    expect((await row(unmatched)).cleaned_at).toBeNull();
    expect((await links(unverified)).length).toBe(0);
  });

  it("does nothing twice", async () => {
    await message();
    expect(await cleanPending()).toMatchObject({ messages: 1 });
    expect(await cleanPending()).toMatchObject({ messages: 0, links: 0 });
    const [c] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM inbound_links");
    expect(c.n).toBe(1);
  });

  it("cleans a message again when the rules have been improved, replacing what the old rules made", async () => {
    const id = await message();
    await cleanPending();
    // Pretend an older version produced something worse: wrong text, a stray link, an old version number.
    await db.query("UPDATE inbound_messages SET text_clean = 'old rules output', clean_version = 1 WHERE id = $1", [id]);
    await db.query(
      "INSERT INTO inbound_links (message_id, url, host, source, created_at) VALUES ($1, 'https://stray.test/', 'stray.test', 'html', now()::text)",
      [id],
    );
    expect(await cleanPending()).toMatchObject({ messages: 1 });
    expect((await row(id)).text_clean).toBe("Answer\n\nProfile");
    expect((await row(id)).clean_version).toBe(CLEAN_VERSION);
    expect((await links(id)).map((l) => l.host)).toEqual(["portal.vendor.com"]); // the stray link is gone
    expect(await cleanPending()).toMatchObject({ messages: 0 }); // and it is not repeated
  });

  it("cleans a plain-text message too", async () => {
    const id = await message({ type: "text", body: "Rate is $300.\n\nOn Mon, X wrote:\n> q\n\n-- \nSig", subject: "Re: rate" });
    await cleanPending();
    expect((await row(id)).text_clean).toBe("Rate is $300.");
  });

  it("retries a message the cleaner cannot store, then gives up and reports it", async () => {
    const id = await message();
    await db.query(`CREATE OR REPLACE FUNCTION fail_links() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$ LANGUAGE plpgsql`);
    await db.query("CREATE TRIGGER fail_links_trg BEFORE INSERT ON inbound_links FOR EACH ROW EXECUTE FUNCTION fail_links()");
    try {
      const first = await cleanPending();
      expect(first).toMatchObject({ messages: 0, failed: 1 });
      expect(first.errors[0]).toContain("boom");
      let last = first;
      for (let i = 0; i < MAX_CLEAN_TRIES + 2; i++) last = await cleanPending();
      expect(last).toMatchObject({ messages: 0, failed: 0, abandoned: 1 }); // left alone, but reported
      expect((await row(id)).cleaned_at).toBeNull();
    } finally {
      await db.query("DROP TRIGGER IF EXISTS fail_links_trg ON inbound_links");
      await db.query("DROP FUNCTION IF EXISTS fail_links()");
    }
  });

  it("removes the cleaned text and links when a message stops being verified, and again when it is purged", async () => {
    const r = await createProject(validBrief(), person(ALICE));
    if (!r.ok) throw new Error("project");
    const id = await message();
    await db.query("UPDATE inbound_messages SET project_id = $2, from_address = 'intake1@vendor.test' WHERE id = $1", [id, r.id]);
    await cleanPending();
    expect((await links(id)).length).toBe(1);

    await db.query("UPDATE vendors SET active = 0"); // the sender is no longer a known vendor
    expect((await assignToProject(id, r.id)).status).toBe("Unverified");
    expect(await row(id)).toMatchObject({ text_clean: null, text_removed: null, cleaned_at: null, clean_info: null });
    expect((await links(id)).length).toBe(0);

    await db.query("UPDATE vendors SET active = 1");
    vi.stubEnv("SENDER_AUTH", "off");
    expect((await assignToProject(id, r.id)).status).toBe("Matched"); // verified again
    await cleanPending(); // cleaned again by the next poll
    expect((await row(id)).text_clean).toBe("Answer\n\nProfile");
    expect((await links(id)).length).toBe(1);

    await db.query("UPDATE inbound_messages SET retain_until = '2026-01-01T00:00:00Z' WHERE id = $1", [id]);
    expect(await purgeExpired(new Date("2026-06-01T00:00:00Z"))).toBe(1);
    expect(await row(id)).toMatchObject({ body: "", text_clean: null, text_removed: null, clean_info: null });
    expect((await links(id)).length).toBe(0); // a link can carry a secret, so it goes with the message
  });

  it("runs as part of a poll, after matching", async () => {
    vi.stubEnv("SENDER_AUTH", "off");
    const p = await createProject(validBrief(), person(ALICE));
    if (!p.ok) throw new Error("project");
    const [proj] = await db.query<{ code: string }>("SELECT code FROM projects WHERE id = $1", [p.id]);
    const m: InboundMessage = {
      graphId: "poll1",
      internetMessageId: "<poll1@vendor.test>",
      conversationId: "cp1",
      receivedAt: "2026-11-25T10:00:00Z",
      fromAddress: "intake1@vendor.test",
      fromName: "V",
      toAddresses: [],
      subject: `Re: [${proj.code}] request`,
      bodyType: "html",
      body: '<p>Candidates: <a href="https://portal.vendor.com/c/9">see portal</a></p><blockquote>our brief</blockquote>',
      hasAttachments: false,
      headers: null,
    };
    const reader: InboxReader = {
      name: "t/inbox",
      async readChanges(_c, _s, onPage) {
        await onPage([m], null);
        return "d1";
      },
    };
    const res = await pollInbox(reader);
    expect(res.matching).toMatchObject({ matched: 1 });
    expect(res.cleaning).toMatchObject({ messages: 1, links: 1, failed: 0 });
    expect(res.errors).toEqual([]);
  });
});
