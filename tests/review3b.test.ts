import { describe, expect, it } from "vitest";
import { extractionProvider } from "@/lib/ai/config";
import { validateExtraction } from "@/lib/ai/schema";
import { cleanMessage } from "@/lib/mail/clean";

const f = (value: string, quote = value) => ({ value, confidence: 0.9, quote });

describe("second round of review", () => {
  it("requires the whole name, in order, with digits", () => {
    const text = "Jane Doe is a CFO. John Smith is a COO. Expert 3: CTO.";
    const names = (n: string) => validateExtraction({ candidates: [{ name: f(n, n) }] }, text).candidates.length;
    expect(names("Jane Smith")).toBe(0); // words borrowed from two people
    expect(names("Expert 9")).toBe(0);
    expect(names("Jane Doe")).toBe(1);
    expect(names("Expert 3")).toBe(1);
    expect(validateExtraction({ candidates: [{ name: f("Maria Lindqvist", "Lindqvist, Maria") }] }, "Lindqvist, Maria, VP").candidates.length).toBe(1);
  });

  it("needs evidence of the currency, and an explicit code beats a symbol", () => {
    const rate = (currency: string, quote: string) =>
      validateExtraction(
        { candidates: [{ name: f("Ana Ruiz"), rate: { amount: 600, currency, unit: "hour", confidence: 0.9, quote } }] },
        `Ana Ruiz. ${quote}.`,
      ).candidates[0]?.rate;
    expect(rate("USD", "600 CAD per hour")).toBeUndefined();
    expect(rate("CAD", "CAD $600 per hour")).toMatchObject({ currency: "CAD" });
    expect(rate("USD", "rate 600 per hour")).toBeUndefined(); // no currency in the quote
    expect(rate("USD", "$600 per hour")).toMatchObject({ currency: "USD" });
  });

  it("hides opacity:0!important, and keeps a joiner written as an entity", () => {
    const r = cleanMessage({ bodyType: "html", body: '<p>Visible</p><p style="opacity:0!important">secret</p>', subject: "x" });
    expect(r.clean).toContain("Visible");
    expect(r.clean).not.toContain("secret");
    expect(cleanMessage({ bodyType: "html", body: "<p>می&zwnj;خواهم</p>", subject: "x" }).clean).toContain("‌");
  });

  it("never empties a message whose whole body is inside a quote block", () => {
    const r = cleanMessage({
      bodyType: "html",
      body: '<blockquote>Jane Doe, CFO at Acme <a href="https://v.example/j">profile</a></blockquote>',
      subject: "x",
    });
    expect(r.clean).toContain("Jane Doe");
    expect(r.info.quoteCutSkipped).toBe(true);
  });

  it("treats an empty EXTRACT_PROVIDER as the default", () => {
    expect(extractionProvider({ EXTRACT_PROVIDER: "  " })).toBe("anthropic");
  });
});
