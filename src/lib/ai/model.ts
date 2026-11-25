/**
 * The only place that talks to a language model.
 *
 * Everything else in the extraction pipeline sees a `ModelClient`: one function that takes a fixed
 * instruction, some quoted text and a JSON schema, and returns text. There are no tools, no agent loop and
 * no streaming: each call is one request and one answer, so the pipeline is plain code that can be tested
 * with a fake client.
 *
 * `AnthropicClient` calls the Claude Messages API over HTTPS. It uses fetch rather than the official SDK
 * because the SDK could not be installed where this was written (the package registry was unreachable); the
 * surface it needs is one endpoint and is small enough to swap for the SDK later without touching callers.
 */
export type Effort = "low" | "medium" | "high";

export type ModelRequest = {
  /** Fixed instructions. Never contains email text. */
  system: string;
  /** The material to work on, with email text quoted as data. */
  user: string;
  /** JSON Schema the answer must follow (the API enforces it, and the caller validates it again). */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
};

export type ModelResponse = {
  text: string;
  model: string;
  stopReason: string;
  requestId: string | null;
  usage: { input: number; output: number; cacheRead: number };
};

export interface ModelClient {
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * What went wrong, in terms the pipeline acts on:
 *   transient  the same request may well work later (network, rate limit, overload, timeout, cut-off output)
 *   auth       the key or access is wrong; every call will fail until a person fixes it
 *   refusal    the model declined; asking again will not help
 *   request    the request was rejected as malformed; asking again will not help
 */
export type ModelErrorKind = "transient" | "auth" | "refusal" | "request";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  constructor(kind: ModelErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
  get retryable() {
    return this.kind === "transient";
  }
}

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  /** Re-run a declined request on a fallback model, inside the same call (server-side, opt-out). */
  fallbacks?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

const API_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

type ApiBody = {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  error?: { type?: string; message?: string };
};

export class AnthropicClient implements ModelClient {
  readonly model: string;
  private o: Required<Pick<AnthropicOptions, "apiKey" | "baseUrl" | "timeoutMs">> & AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.model = opts.model;
    this.o = { baseUrl: "https://api.anthropic.com", timeoutMs: 120_000, ...opts };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.o.apiKey,
      "anthropic-version": API_VERSION,
    };
    if (this.o.fallbacks) headers["anthropic-beta"] = FALLBACK_BETA;

    // No `thinking`, `temperature` or tool fields: thinking is always on for this model and sampling
    // parameters are rejected; depth is set with effort, and the answer shape with the schema.
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
    };
    if (this.o.fallbacks) body.fallbacks = "default";

    let res: Response;
    try {
      res = await (this.o.fetchFn ?? fetch)(`${this.o.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      // Never include the request: it holds the email text.
      throw new ModelError("transient", `Model request failed: ${(e as Error).name}`);
    }

    const requestId = res.headers.get("request-id");
    let json: ApiBody = {};
    try {
      json = (await res.json()) as ApiBody;
    } catch {
      if (res.ok) throw new ModelError("transient", "Model reply was not JSON", res.status);
    }

    if (!res.ok) {
      const detail = `${json.error?.type ?? "error"}: ${(json.error?.message ?? "").slice(0, 200)}`;
      const kind: ModelErrorKind =
        res.status === 401 || res.status === 403 ? "auth" : RETRYABLE_STATUS.has(res.status) ? "transient" : "request";
      throw new ModelError(kind, `Model API ${res.status} (${detail})`, res.status);
    }

    const stopReason = json.stop_reason ?? "";
    if (stopReason === "refusal") throw new ModelError("refusal", "The model declined this request");
    if (stopReason === "max_tokens") throw new ModelError("transient", "The model's answer was cut off");
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) throw new ModelError("transient", "The model returned no text");

    return {
      text,
      model: json.model ?? this.model,
      stopReason,
      requestId,
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
        cacheRead: json.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }
}
