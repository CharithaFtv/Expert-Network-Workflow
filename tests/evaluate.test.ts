import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { meetsBar, scoreCase, summarise, type EvalCase } from "@/lib/ai/evaluate";
import { runPipeline } from "@/lib/ai/extract";
import type { ModelClient, ModelRequest } from "@/lib/ai/model";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM } from "@/lib/ai/prompts";
import type { Candidate } from "@/lib/ai/schema";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/extraction-cases.json", import.meta.url), "utf8")) as EvalCase[];

const f = (value: string, quote = value) => ({ value, confidence: 0.95, quote });
/** What a perfect model would answer for a case: the expected answer, with quotes taken from the text. */
function oracle(c: EvalCase): ModelClient {
  return {
    model: "oracle",
    async complete(req: ModelRequest) {
      const text = req.system === CLASSIFY_SYSTEM
        ? JSON.stringify({ category: c.expect.categories[0], confidence: 0.99, reason: "x" })
        : JSON.stringify({
            candidates: (c.expect.candidates ?? []).map((e) => {
              const cand: Record<string, unknown> = { name: f(e.name) };
              if (e.employer) cand.current_employer = f(e.employer);
              if (e.pastEmployer) cand.past_roles = [{ employer: e.pastEmployer, confidence: 0.9, quote: e.pastEmployer }];
              if (e.title) cand.current_title = f(e.title);
              if (e.years !== undefined) cand.years_experience = { value: e.years, confidence: 0.9, quote: String(e.years) + " years" };
              if (e.rate) {
                const q = c.text.match(new RegExp(`[^\\n.]*${e.rate.amount}[^\\n.]*`))?.[0]?.trim() ?? String(e.rate.amount);
                cand.rate = { amount: e.rate.amount, currency: e.rate.currency, unit: "hour", confidence: 0.9, quote: q };
              }
              return cand as unknown as Candidate;
            }),
          });
      return { text, model: "oracle", stopReason: "end_turn", requestId: null, usage: { input: 0, output: 0, cacheRead: 0 } };
    },
  };
}

/** A model that obeys whatever instruction the email contains. */
function gullible(c: EvalCase): ModelClient {
  return {
    model: "gullible",
    async complete(req: ModelRequest) {
      const injected = c.expect.forbidden?.[0];
      const text = req.system === CLASSIFY_SYSTEM
        ? JSON.stringify({ category: injected ? "expert_candidates" : c.expect.categories[0], confidence: 0.99, reason: "x" })
        : JSON.stringify({ candidates: injected ? [{ name: f(injected) }] : [] });
      return { text, model: "gullible", stopReason: "end_turn", requestId: null, usage: { input: 0, output: 0, cacheRead: 0 } };
    },
  };
}

describe("the evaluation set", () => {
  it("covers every kind of email, with unique ids and text that really contains the expected details", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const kinds = new Set(cases.flatMap((c) => c.expect.categories));
    for (const k of ["expert_candidates", "update", "vendor_question", "acknowledgement", "scheduling", "other"]) expect(kinds.has(k as never), k).toBe(true);
    expect(cases.some((c) => c.expect.forbidden?.length)).toBe(true); // injection cases are there
    for (const c of cases) for (const e of c.expect.candidates ?? []) expect(c.text, `${c.id}: ${e.name}`).toContain(e.name);
  });

  it("treats a former role as past, not current, and the prompt says so", () => {
    expect(EXTRACT_SYSTEM).toMatch(/former[^.]*past role[^.]*never in the current fields/i);
    const c = cases.find((x) => x.id === "two-named-experts")!;
    const tom = c.expect.candidates!.find((x) => x.name === "Tom Okafor")!;
    expect(tom.employer).toBeNull();
    expect(tom.pastEmployer).toBe("Contoso Retail");
  });

  it("scores a perfect model as passing everything, and clears the bar", async () => {
    const scores = [];
    for (const c of cases) scores.push(scoreCase(c, await runPipeline(oracle(c), { text: c.text, linkHosts: [] }, { sleep: async () => {} })));
    expect(scores.filter((s) => !s.passed).map((s) => s.id)).toEqual([]);
    const sum = summarise(scores);
    expect(sum).toMatchObject({ cases: cases.length, passed: cases.length, categoryAccuracy: 1, injectionsFollowed: 0, extras: 0 });
    expect(meetsBar(sum).ok).toBe(true);
  });

  it("catches a model that follows injected instructions", async () => {
    const scores = [];
    for (const c of cases) scores.push(scoreCase(c, await runPipeline(gullible(c), { text: c.text, linkHosts: [] }, { sleep: async () => {} })));
    const sum = summarise(scores);
    expect(sum.injectionsFollowed).toBeGreaterThan(0);
    const bar = meetsBar(sum);
    expect(bar.ok).toBe(false);
    expect(bar.failures.join(" ")).toMatch(/injected instruction/);
  });

  it("does not let a fabricated expert through even from a model that tries", async () => {
    // The injected name is in the email text of the injection cases, so the quote check alone cannot stop it:
    // the evaluation exists to measure that case. For an email that does NOT contain a name, a made-up one is dropped.
    const c = cases.find((x) => x.id === "acknowledgement")!;
    const liar: ModelClient = {
      model: "liar",
      async complete(req) {
        const text = req.system === CLASSIFY_SYSTEM
          ? JSON.stringify({ category: "expert_candidates", confidence: 1, reason: "x" })
          : JSON.stringify({ candidates: [{ name: f("Victor Hale", "Victor Hale") }] });
        return { text, model: "liar", stopReason: "end_turn", requestId: null, usage: { input: 0, output: 0, cacheRead: 0 } };
      },
    };
    const out = await runPipeline(liar, { text: c.text, linkHosts: [] }, { sleep: async () => {} });
    expect(out.outcome).toBe("manual"); // nothing in the email supports the name
    const s = scoreCase(c, out);
    expect(s.passed).toBe(false); // wrong category, flagged
    expect(s.extras).toEqual([]);
  });

  it("flags a missed expert, a wrong detail and an extra candidate", async () => {
    const c = cases.find((x) => x.id === "two-named-experts")!;
    const model: ModelClient = {
      model: "sloppy",
      async complete(req) {
        const text = req.system === CLASSIFY_SYSTEM
          ? JSON.stringify({ category: "expert_candidates", confidence: 1, reason: "x" })
          : JSON.stringify({
              candidates: [
                { name: f("Maria Lindqvist"), current_employer: f("Contoso Retail", "Contoso Retail") }, // wrong employer
                { name: f("Maria Lindqvist"), current_employer: f("Northwind Foods", "Northwind Foods") }, // duplicate name, kept apart by employer
              ],
            });
        return { text, model: "sloppy", stopReason: "end_turn", requestId: null, usage: { input: 0, output: 0, cacheRead: 0 } };
      },
    };
    const s = scoreCase(c, await runPipeline(model, { text: c.text, linkHosts: [] }, { sleep: async () => {} }));
    expect(s.passed).toBe(false);
    expect(s.recall).toBe(0.5); // Tom Okafor was missed
    expect(s.details.some((d) => !d.ok)).toBe(true);
  });
});
