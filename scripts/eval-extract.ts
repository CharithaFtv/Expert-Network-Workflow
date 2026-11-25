import fs from "node:fs";
import { extractionClientFromEnv } from "../src/lib/ai/config.ts";
import { meetsBar, scoreCase, summarise, type CaseScore, type EvalCase } from "../src/lib/ai/evaluate.ts";
import { runPipeline } from "../src/lib/ai/extract.ts";
import { neutralise, PROMPT_VERSION } from "../src/lib/ai/prompts.ts";

// Usage: npm run eval-extract -- --yes
// Runs the fixed synthetic vendor replies in tests/fixtures/extraction-cases.json through the REAL model and
// scores the results. It makes live API calls (one or two per case) and costs money, so it needs --yes.
// The synthetic text contains no real people or deals. Exit code 1 if the model does not clear the bar.
let exitCode = 0;
try {
  const cases = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/extraction-cases.json", import.meta.url), "utf8")) as EvalCase[];
  const client = extractionClientFromEnv();
  if (!client) throw new Error('Set EXTRACTION_MODE=on and ANTHROPIC_API_KEY first (the evaluation calls the real model).');
  if (!process.argv.includes("--yes")) {
    console.log(`This will send ${cases.length} synthetic emails to ${client.model} (1 to 2 calls each) and cost a small amount.`);
    console.log("Nothing was sent. Run again with --yes to go ahead.");
  } else {
    console.log(`prompt ${PROMPT_VERSION}, model ${client.model}, ${cases.length} cases\n`);
    const scores: CaseScore[] = [];
    for (const c of cases) {
      const out = await runPipeline(client, { text: neutralise(c.text), linkHosts: [] });
      const s = scoreCase(c, out);
      scores.push(s);
      const bad = [
        !s.categoryOk && "wrong category",
        s.recall !== null && s.recall < 1 && "missed an expert",
        s.extras.length && `extra: ${s.extras.join(", ")}`,
        s.forbiddenHit.length && `FOLLOWED INJECTION: ${s.forbiddenHit.join(", ")}`,
        ...s.details.filter((d) => !d.ok).map((d) => `wrong ${d.field}`),
        out.outcome !== "extracted" && out.outcome !== "classified" && `outcome ${out.outcome}: ${"error" in out ? out.error.message : "reason" in out ? out.reason : ""}`,
      ].filter(Boolean);
      console.log(`${s.passed ? "PASS" : "FAIL"}  ${c.id}${bad.length ? `  (${bad.join("; ")})` : ""}${s.dropped ? `  [${s.dropped} unsupported field(s) removed]` : ""}`);
    }
    const sum = summarise(scores);
    console.log("\n", sum);
    const bar = meetsBar(sum);
    console.log(bar.ok ? "\nThe model clears the bar." : `\nThe model does NOT clear the bar:\n- ${bar.failures.join("\n- ")}`);
    if (!bar.ok) exitCode = 1;
  }
} catch (e) {
  console.error(`eval-extract: ${(e as Error).message}`);
  exitCode = 1;
}
process.exit(exitCode);
