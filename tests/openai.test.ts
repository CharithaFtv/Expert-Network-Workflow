import { describe, expect, it } from "vitest";
import { extractionClientFromEnv, extractionProvider } from "@/lib/ai/config";
import { ModelError, type ModelRequest } from "@/lib/ai/model";
import { OpenAIClient, strictSchema } from "@/lib/ai/openai";
import { CLASSIFY_SCHEMA, EXTRACT_SCHEMA, validateExtraction } from "@/lib/ai/schema";

describe("strictSchema", () => {
  type S = { type: string; properties: Record<string, S & { anyOf?: S[] }>; required: string[]; additionalProperties: boolean; items?: S };
  const out = strictSchema(EXTRACT_SCHEMA) as unknown as S;
  const cand = (out.properties.candidates.items as S);

  it("lists every property as required, and lets the formerly optional ones be null", () => {
    expect(cand.required.sort()).toEqual(Object.keys(cand.properties).sort());
    expect(cand.properties.name.type).toBe("object"); // was required: unchanged
    for (const k of ["current_title", "rate", "past_roles", "years_experience"]) {
      expect(cand.properties[k].anyOf?.map((x) => x.type)).toContain("null");
    }
  });
  it("closes every object, inside arrays too, and leaves the original untouched", () => {
    const allClosed = (s: unknown): boolean =>
      typeof s !== "object" || s === null
        ? true
        : (s as S).type === "object"
          ? (s as S).additionalProperties === false && (s as S).required.length === Object.keys((s as S).properties).length && Object.values((s as S).properties).every(allClosed)
          : Object.values(s).every(allClosed);
    expect(allClosed(out)).toBe(true);
    expect((EXTRACT_SCHEMA.properties.candidates.items as unknown as S).required).toEqual(["name"]); // not mutated
    expect((strictSchema(CLASSIFY_SCHEMA) as unknown as S).required).toEqual(["category", "confidence", "reason"]);
  });
});

describe("validators", () => {
  it("treat null like a missing field", () => {
    const src = "Maria Lindqvist, VP at Acme. $600 per hour.";
    const raw = {
      candidates: [
        {
          name: { value: "Maria Lindqvist", confidence: 0.9, quote: "Maria Lindqvist" },
          current_title: null, current_employer: null, past_roles: null, geography: null, years_experience: null, availability: null,
          vendor_notes: null, rate: { amount: 600, currency: "USD", unit: null, confidence: 0.9, quote: "$600 per hour" },
        },
      ],
    };
    const { candidates, dropped } = validateExtraction(raw, src);
    expect(dropped).toEqual([]);
    expect(candidates[0].name.value).toBe("Maria Lindqvist");
    expect(candidates[0].rate).toMatchObject({ amount: 600, currency: "USD" });
    expect(candidates[0].rate?.unit).toBeUndefined();
  });
});

describe("OpenAIClient", () => {
  const REQ: ModelRequest = { system: "SYS", user: "the email text", schema: CLASSIFY_SCHEMA, maxTokens: 321, effort: "medium" };
  const ok = (over: object = {}) =>
    new Response(
      JSON.stringify({
        model: "gpt-test",
        choices: [{ finish_reason: "stop", message: { content: '{"a":1}', refusal: null } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
        ...over,
      }),
      { status: 200, headers: { "x-request-id": "req_oa" } },
    );
  function client(respond: () => Response | Promise<Response>, extra: object = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    return { c: new OpenAIClient({ apiKey: "sk-openai-secret", model: "gpt-test", fetchFn, ...extra }), calls };
  }

  it("sends one request in the documented shape, with strict JSON-schema output and no sampling or tool fields", async () => {
    const { c, calls } = client(() => ok());
    const r = await c.complete(REQ);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk-openai-secret");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({
      model: "gpt-test",
      max_completion_tokens: 321,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "the email text" }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true } },
    });
    expect(body.response_format.json_schema.schema).toEqual(strictSchema(CLASSIFY_SCHEMA));
    for (const k of ["temperature", "top_p", "tools", "tool_choice", "stream", "reasoning_effort"]) expect(body, k).not.toHaveProperty(k);
    expect(r).toMatchObject({ text: '{"a":1}', requestId: "req_oa", usage: { input: 7, output: 3, cacheRead: 2 }, stopReason: "stop" });
  });

  it("sends reasoning effort only when asked to", async () => {
    const { c, calls } = client(() => ok(), { reasoningEffort: true });
    await c.complete(REQ);
    expect(JSON.parse(calls[0].init.body as string).reasoning_effort).toBe("medium");
  });

  it("sorts failures into the kinds the pipeline acts on", async () => {
    const err = (s: number, code = "x") => () => new Response(JSON.stringify({ error: { type: "t", code, message: "m" } }), { status: s });
    const kind = async (r: () => Response) => ((await client(r).c.complete(REQ).catch((e) => e)) as ModelError).kind;
    expect(await kind(err(401))).toBe("auth");
    expect(await kind(err(403))).toBe("auth");
    expect(await kind(err(429, "insufficient_quota"))).toBe("auth"); // out of credit: stop the run, do not retry
    for (const s of [408, 429, 500, 503]) expect(await kind(err(s)), String(s)).toBe("transient");
    expect(await kind(err(400, "invalid_request_error"))).toBe("request");
    expect(await kind(() => ok({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't help" } }] }))).toBe("refusal");
    expect(await kind(() => ok({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }))).toBe("refusal");
    expect(await kind(() => ok({ choices: [{ finish_reason: "length", message: { content: '{"a"' } }] }))).toBe("transient");
    expect(await kind(() => ok({ choices: [{ finish_reason: "stop", message: { content: "" } }] }))).toBe("transient");
    expect(await kind(() => new Response("<html>bad gateway</html>", { status: 502 }))).toBe("transient");
  });

  it("never puts the email or the key in an error, but does say why a request could not go out", async () => {
    const boom = client(() => {
      throw Object.assign(new TypeError("fetch failed the email text sk-openai-secret"), { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } });
    });
    const e = (await boom.c.complete(REQ).catch((x) => x)) as ModelError;
    expect(e.kind).toBe("transient");
    expect(e.message).toBe("Model request failed: TypeError (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)");
    expect(e.message).not.toContain("the email text");
    expect(e.message).not.toContain("sk-openai-secret");
    // A cause whose code could carry text is not repeated.
    const odd = client(() => {
      throw Object.assign(new Error("x"), { cause: { code: "contains the email text" } });
    });
    expect(((await odd.c.complete(REQ).catch((x) => x)) as ModelError).message).toBe("Model request failed: Error");
  });

  it("refuses to start without a key or a model", () => {
    expect(() => new OpenAIClient({ apiKey: "", model: "m" })).toThrow(/OPENAI_API_KEY/);
    expect(() => new OpenAIClient({ apiKey: "k", model: "" })).toThrow(/EXTRACT_MODEL/);
  });
});

describe("provider settings", () => {
  it("defaults to Anthropic, and refuses anything else it does not know", () => {
    expect(extractionProvider({})).toBe("anthropic");
    expect(extractionProvider({ EXTRACT_PROVIDER: " OpenAI " })).toBe("openai");
    expect(() => extractionProvider({ EXTRACT_PROVIDER: "gemini" })).toThrow(/"anthropic" or "openai"/);
  });
  it("builds an OpenAI client only with a key and an explicit model, and never guesses the provider from the keys", () => {
    const base = { EXTRACTION_MODE: "on", EXTRACT_PROVIDER: "openai" };
    expect(() => extractionClientFromEnv({ ...base, EXTRACT_MODEL: "m" })).toThrow(/OPENAI_API_KEY/);
    expect(() => extractionClientFromEnv({ ...base, OPENAI_API_KEY: "k" })).toThrow(/EXTRACT_MODEL/);
    expect(extractionClientFromEnv({ ...base, OPENAI_API_KEY: "k", EXTRACT_MODEL: "gpt-test" })?.model).toBe("gpt-test");
    // An OpenAI key alone does not switch the provider: the default is still Anthropic, which has no key here.
    expect(() => extractionClientFromEnv({ EXTRACTION_MODE: "on", OPENAI_API_KEY: "k" })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("uses the provider's real address when no base URL is set, for either provider (a real bug: an unset option erased the default)", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }], content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const REQ: ModelRequest = { system: "s", user: "u", schema: CLASSIFY_SCHEMA, maxTokens: 10, effort: "low" };
    const oa = extractionClientFromEnv({ EXTRACTION_MODE: "on", EXTRACT_PROVIDER: "openai", OPENAI_API_KEY: "k", EXTRACT_MODEL: "m" }, fetchFn)!;
    const an = extractionClientFromEnv({ EXTRACTION_MODE: "on", ANTHROPIC_API_KEY: "k" }, fetchFn)!;
    await oa.complete(REQ);
    await an.complete(REQ);
    expect(urls).toEqual(["https://api.openai.com/v1/chat/completions", "https://api.anthropic.com/v1/messages"]);
    // And an explicit base URL is still honoured.
    const custom = extractionClientFromEnv({ EXTRACTION_MODE: "on", EXTRACT_PROVIDER: "openai", OPENAI_API_KEY: "k", EXTRACT_MODEL: "m", OPENAI_BASE_URL: "https://proxy.example" }, fetchFn)!;
    await custom.complete(REQ);
    expect(urls[2]).toBe("https://proxy.example/v1/chat/completions");
  });

  it("is still off by default whatever keys exist", () => {
    expect(extractionClientFromEnv({ OPENAI_API_KEY: "k", EXTRACT_PROVIDER: "openai", EXTRACT_MODEL: "m" })).toBeNull();
  });
});
