import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/ai/extract";
import { ModelError, type ModelClient } from "@/lib/ai/model";
import { CLASSIFY_SYSTEM } from "@/lib/ai/prompts";
import { validateExtraction } from "@/lib/ai/schema";
import { cleanMessage } from "@/lib/mail/clean";
import { stripInvisible } from "@/lib/mail/html";

const f = (value: string, quote = value) => ({ value, confidence: 0.9, quote });
const usage = { input: 0, output: 0, cacheRead: 0 };

describe("quotes must support what they are attached to", () => {
  const text = "Proposing Ana Ruiz, formerly at Google, 300 GBP per hour.";
  it("drops an employer that its quote does not state", () => {
    const out = validateExtraction(
      { candidates: [{ name: f("Ana Ruiz"), current_employer: f("Initrode", "Ana Ruiz, formerly at Google") }] },
      text,
    );
    expect(out.candidates[0].current_employer).toBeUndefined();
    expect(out.dropped.some((d) => d.field === "current_employer")).toBe(true);
  });
  it("drops a rate whose currency contradicts the quote", () => {
    const out = validateExtraction(
      { candidates: [{ name: f("Ana Ruiz"), rate: { amount: 300, currency: "USD", unit: "hour", confidence: 0.9, quote: "300 GBP per hour" } }] },
      text,
    );
    expect(out.candidates[0].rate).toBeUndefined();
  });
  it("keeps the amount but loses a unit the quote contradicts", () => {
    const out = validateExtraction(
      { candidates: [{ name: f("Ana Ruiz"), rate: { amount: 300, currency: "GBP", unit: "call", confidence: 0.9, quote: "300 GBP per hour" } }] },
      text,
    );
    expect(out.candidates[0].rate).toMatchObject({ amount: 300, currency: "GBP" });
    expect(out.candidates[0].rate?.unit).toBeUndefined();
  });
});

describe("setup errors stop the run, and the audit survives", () => {
  const clientFailing = (err: ModelError): ModelClient => ({
    model: "x",
    async complete() {
      throw err;
    },
  });
  it("aborts on a 404 (wrong model) instead of marking the message manual", async () => {
    const out = await runPipeline(clientFailing(new ModelError("request", "no such model", 404)), { text: "hello", linkHosts: [] }, { sleep: async () => {} });
    expect(out.outcome).toBe("aborted");
  });
  it("keeps what was dropped when validation fails twice", async () => {
    const liar: ModelClient = {
      model: "liar",
      async complete(req) {
        const text = req.system === CLASSIFY_SYSTEM
          ? JSON.stringify({ category: "expert_candidates", confidence: 1, reason: "x" })
          : JSON.stringify({ candidates: [{ name: f("Victor Hale") }] });
        return { text, model: "liar", stopReason: "end_turn", requestId: null, usage };
      },
    };
    const out = await runPipeline(liar, { text: "Received, thanks.", linkHosts: [] }, { sleep: async () => {} });
    expect(out.outcome).toBe("manual");
    if (out.outcome === "manual") expect(out.dropped.length).toBeGreaterThan(0);
  });
});

describe("cleaning", () => {
  it("does not cut experts that follow a bare -- separator", () => {
    const body = "Profiles:\nExpert 1: CFO, 500 EUR per hour\n--\nExpert 2: COO, 650 EUR per hour\n--\nExpert 3: CTO, 400 EUR per hour";
    const r = cleanMessage({ bodyType: "text", body, subject: "x" });
    expect(r.clean).toContain("Expert 3");
  });
  it("still cuts a real signature", () => {
    const r = cleanMessage({ bodyType: "text", body: "Thanks, will revert.\n\n--\nJo Smith\nVendor Ltd", subject: "x" });
    expect(r.clean).not.toContain("Vendor Ltd");
  });
  it("keeps joiners that belong to words, and still removes zero-width spaces", () => {
    expect(stripInvisible("می‌خواهم")).toContain("‌");
    expect(stripInvisible("a​b")).toBe("ab");
  });
  it("keeps a link whose text spans several blocks", () => {
    const r = cleanMessage({
      bodyType: "html",
      body: '<p>See <a href="https://vendor.example/p/1"><div>View</div><div>profile</div></a></p>',
      subject: "x",
    });
    expect(r.links.map((l) => l.url)).toContain("https://vendor.example/p/1");
  });
});
