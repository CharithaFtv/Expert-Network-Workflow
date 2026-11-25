import { AnthropicClient, type ModelClient } from "./model.ts";
import { OpenAIClient } from "./openai.ts";

type Env = Record<string, string | undefined>;

/**
 * Extraction is OFF unless EXTRACTION_MODE=on. Turning it on sends the cleaned text of verified vendor
 * replies (expert names, employers, rates) to the chosen provider's API, so it is a decision for FTV to take,
 * not a default. When off, nothing leaves the machine and messages simply wait.
 */
export function extractionMode(env: Env = process.env): "off" | "on" {
  const v = (env.EXTRACTION_MODE ?? "off").trim().toLowerCase();
  if (v === "on" || v === "off" || v === "") return v === "on" ? "on" : "off";
  throw new Error(`EXTRACTION_MODE must be "on" or "off", not "${v}".`);
}

export type Provider = "anthropic" | "openai";

/** Which provider's API to call. Explicit: it never guesses from which keys happen to be set. */
export function extractionProvider(env: Env = process.env): Provider {
  const v = (env.EXTRACT_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (v === "anthropic" || v === "openai") return v;
  throw new Error(`EXTRACT_PROVIDER must be "anthropic" or "openai", not "${v}".`);
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** The model client for this environment, or null when extraction is off. Throws if it is on but not set up. */
export function extractionClientFromEnv(env: Env = process.env, fetchFn?: typeof fetch): ModelClient | null {
  if (extractionMode(env) === "off") return null;
  const provider = extractionProvider(env);
  const model = env.EXTRACT_MODEL?.trim();

  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("EXTRACT_PROVIDER=openai needs OPENAI_API_KEY.");
    // No default model: which models an account can use is its own, so it must be named.
    if (!model) throw new Error("EXTRACT_PROVIDER=openai needs EXTRACT_MODEL (the OpenAI model to use).");
    return new OpenAIClient({
      apiKey,
      model,
      reasoningEffort: (env.EXTRACT_REASONING_EFFORT ?? "off").trim().toLowerCase() === "on",
      baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      fetchFn,
    });
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("EXTRACTION_MODE=on needs ANTHROPIC_API_KEY (or set EXTRACT_PROVIDER=openai).");
  return new AnthropicClient({
    apiKey,
    model: model || DEFAULT_ANTHROPIC_MODEL,
    // Re-run a declined request on a fallback model, server-side. On by default; EXTRACT_FALLBACKS=off disables it.
    fallbacks: (env.EXTRACT_FALLBACKS ?? "on").trim().toLowerCase() !== "off",
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    fetchFn,
  });
}
