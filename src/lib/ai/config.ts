import { AnthropicClient, type ModelClient } from "./model.ts";

type Env = Record<string, string | undefined>;

/**
 * Extraction is OFF unless EXTRACTION_MODE=on. Turning it on sends the cleaned text of verified vendor
 * replies (expert names, employers, rates) to the Claude API, so it is a decision for FTV to take, not a
 * default. When off, nothing leaves the machine and messages simply wait.
 */
export function extractionMode(env: Env = process.env): "off" | "on" {
  const v = (env.EXTRACTION_MODE ?? "off").trim().toLowerCase();
  if (v === "on" || v === "off" || v === "") return v === "on" ? "on" : "off";
  throw new Error(`EXTRACTION_MODE must be "on" or "off", not "${v}".`);
}

export const DEFAULT_EXTRACT_MODEL = "claude-opus-5-5";

/** The model client for this environment, or null when extraction is off. Throws if it is on but not set up. */
export function extractionClientFromEnv(env: Env = process.env, fetchFn?: typeof fetch): ModelClient | null {
  if (extractionMode(env) === "off") return null;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("EXTRACTION_MODE=on needs ANTHROPIC_API_KEY.");
  return new AnthropicClient({
    apiKey,
    model: env.EXTRACT_MODEL?.trim() || DEFAULT_EXTRACT_MODEL,
    // Re-run a declined request on a fallback model, server-side. On by default; EXTRACT_FALLBACKS=off disables it.
    fallbacks: (env.EXTRACT_FALLBACKS ?? "on").trim().toLowerCase() !== "off",
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    fetchFn,
  });
}
