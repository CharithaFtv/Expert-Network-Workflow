import { describe, expect, it } from "vitest";
import { validateBrief } from "@/lib/projects";
import { ALICE, BOB, DEAL_LEAD, DEAL_PASSED, person, validBrief } from "./helpers";

const alice = () => person(ALICE);
const check = (over: Record<string, unknown> = {}) => validateBrief(validBrief(over), alice());

describe("validateBrief", () => {
  it("accepts a valid brief", async () => {
    const r = await check();
    expect(r.errors).toEqual({});
    expect(r.ok).toBe(true);
  });

  it("accepts a Lead deal", async () => {
    expect((await check({ dealId: DEAL_LEAD })).ok).toBe(true);
  });

  it("rejects a missing deal", async () => {
    expect((await check({ dealId: "" })).errors.dealId).toMatch(/Link/);
  });

  it("rejects an unknown deal", async () => {
    expect((await check({ dealId: "x" })).errors.dealId).toBeDefined();
  });

  it("rejects a deal that is not Active or Lead (server-side rule)", async () => {
    const r = await check({ dealId: DEAL_PASSED });
    expect(r.errors.dealId).toMatch(/Active or Lead/);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["title", { title: "  " }],
    ["objective", { objective: "" }],
    ["targetCompanies", { targetCompanies: [] }],
    ["expertTypes", { expertTypes: ["Not a type"] }],
    ["vendorIds", { vendorIds: [] }],
    ["vendorIds", { vendorIds: [9999] }], // unknown vendor is dropped, then empty
  ])("requires %s", async (field, over) => {
    expect((await check(over)).errors).toHaveProperty(field);
  });

  it.each([0, 51, 2.5, "abc"])("rejects callsTarget %s", async (n) => {
    expect((await check({ callsTarget: n })).errors.callsTarget).toBeDefined();
  });

  it("validates dates", async () => {
    expect((await check({ endDate: "" })).errors.endDate).toBeDefined();
    expect((await check({ endDate: "2000-01-01" })).errors.endDate).toMatch(/past/);
    expect(
      (await check({ startDate: "2099-01-05", endDate: "2099-01-02" })).errors.endDate,
    ).toMatch(/on or after/);
  });

  it("defaults a missing start date to today", async () => {
    const r = await check({ startDate: "" });
    expect(r.input.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("removes the requester from tagged people and flags unknown users", async () => {
    expect((await check({ teamUserIds: [ALICE, BOB] })).input.teamUserIds).toEqual([BOB]);
    expect((await check({ teamUserIds: ["ghost"] })).errors.teamUserIds).toBeDefined();
  });

  it("normalises untrusted input: trims, dedupes, truncates, ignores wrong types", async () => {
    const r = await check({
      title: "x".repeat(500),
      targetCompanies: [" A ", "A", "", 5],
    });
    expect(r.input.title).toHaveLength(140);
    expect(r.input.targetCompanies).toEqual(["A"]); // non-strings dropped
  });

  it("survives garbage payloads", async () => {
    for (const raw of [null, undefined, "str", 42, []]) {
      expect((await validateBrief(raw, alice())).ok).toBe(false);
    }
  });
});
