import { ModelError, networkReason, type ModelClient, type ModelErrorKind, type ModelRequest, type ModelResponse } from "./model.ts";

/**
 * The same ModelClient, backed by the OpenAI Chat Completions API.
 *
 * Only this file knows OpenAI's request and response shapes. The prompts, schemas, validation and quote
 * checks are provider-neutral and identical to the Claude path, so switching provider changes nothing else
 * in the pipeline and the same evaluation set measures either.
 *
 * Structured outputs on OpenAI (`strict: true`) require every property to be listed as required, with the
 * optional ones allowed to be null. `strictSchema` rewrites our schemas that way; the validators already
 * treat null the same as absent.
 */
export type OpenAIOptions = {
  apiKey: string;
  model: string;
  /** Send `reasoning_effort` (only reasoning models accept it; others reject the request). Off by default. */
  reasoningEffort?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

type Json = Record<string, unknown>;

/** Every property required; the ones that were optional may be null. Recurses through objects and arrays. */
export function strictSchema(schema: Json): Json {
  const s: Json = { ...schema };
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const was = new Set((s.required as string[] | undefined) ?? []);
    const props: Json = {};
    for (const [k, v] of Object.entries(s.properties as Json)) {
      const inner = strictSchema(v as Json);
      props[k] = was.has(k) ? inner : { anyOf: [inner, { type: "null" }] };
    }
    s.properties = props;
    s.required = Object.keys(props);
    s.additionalProperties = false;
  } else if (s.type === "array" && s.items) {
    s.items = strictSchema(s.items as Json);
  }
  return s;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

type ApiBody = {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { type?: string; code?: string | null; message?: string };
};

export class OpenAIClient implements ModelClient {
  readonly model: string;
  private o: Required<Pick<OpenAIOptions, "apiKey" | "baseUrl" | "timeoutMs">> & OpenAIOptions;

  constructor(opts: OpenAIOptions) {
    if (!opts.apiKey) throw new Error("OPENAI_API_KEY is not set");
    if (!opts.model) throw new Error("EXTRACT_MODEL must name an OpenAI model when EXTRACT_PROVIDER=openai");
    this.model = opts.model;
    // An option passed as undefined (an unset setting) must fall back to the default, not erase it.
    this.o = { ...opts, baseUrl: opts.baseUrl ?? "https://api.openai.com", timeoutMs: opts.timeoutMs ?? 120_000 };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // No temperature, tools or streaming: one request, one JSON answer. Newer models reject sampling parameters.
    const body: Json = {
      model: this.model,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: strictSchema(req.schema) } },
    };
    if (this.o.reasoningEffort) body.reasoning_effort = req.effort;

    let res: Response;
    try {
      res = await (this.o.fetchFn ?? fetch)(`${this.o.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      throw new ModelError("transient", `Model request failed: ${networkReason(e)}`);
    }

    const requestId = res.headers.get("x-request-id");
    let json: ApiBody = {};
    try {
      json = (await res.json()) as ApiBody;
    } catch {
      if (res.ok) throw new ModelError("transient", "Model reply was not JSON", res.status);
    }

    if (!res.ok) {
      const code = json.error?.code ?? json.error?.type ?? "error";
      const detail = `${code}: ${(json.error?.message ?? "").slice(0, 200)}`;
      // Out of quota or credit is a billing problem: every call fails until a person fixes it, like a bad key.
      const kind: ModelErrorKind =
        res.status === 401 || res.status === 403 || code === "insufficient_quota"
          ? "auth"
          : RETRYABLE_STATUS.has(res.status)
            ? "transient"
            : "request";
      throw new ModelError(kind, `Model API ${res.status} (${detail})`, res.status);
    }

    const choice = json.choices?.[0];
    if (choice?.message?.refusal) throw new ModelError("refusal", "The model declined this request");
    if (choice?.finish_reason === "content_filter") throw new ModelError("refusal", "The model's answer was filtered");
    if (choice?.finish_reason === "length") throw new ModelError("transient", "The model's answer was cut off");
    const text = choice?.message?.content ?? "";
    if (!text.trim()) throw new ModelError("transient", "The model returned no text");

    return {
      text,
      model: json.model ?? this.model,
      stopReason: choice?.finish_reason ?? "",
      requestId,
      usage: {
        input: json.usage?.prompt_tokens ?? 0,
        output: json.usage?.completion_tokens ?? 0,
        cacheRead: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}
