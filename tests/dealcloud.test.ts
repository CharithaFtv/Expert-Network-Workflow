import { describe, expect, it } from "vitest";
import {
  getDeal,
  getUser,
  isEligibleDeal,
  listUsers,
  searchDeals,
  searchUsers,
} from "@/lib/dealcloud";
import { ALICE, BOB, DEAL_ACTIVE, DEAL_LEAD, DEAL_PASSED } from "./helpers";

describe("deal eligibility", () => {
  it("accepts Active and Lead only", () => {
    expect(isEligibleDeal(getDeal(DEAL_ACTIVE))).toBe(true);
    expect(isEligibleDeal(getDeal(DEAL_LEAD))).toBe(true);
    expect(isEligibleDeal(getDeal(DEAL_PASSED))).toBe(false);
    expect(isEligibleDeal(undefined)).toBe(false);
  });

  it("searchDeals never returns ineligible deals", () => {
    const names = searchDeals("").map((d) => d.name);
    expect(names).not.toContain("Gamma Passed");
    expect(names).toContain("Zeta Active");
  });

  it("ranks the caller's own deals first, then Active, then Lead", () => {
    const names = searchDeals("", ALICE).map((d) => d.name);
    expect(names[0]).toBe("Zeta Active"); // Alice is on the team
    expect(names.indexOf("Beta Active")).toBeLessThan(names.indexOf("Alpha Lead"));
  });

  it("filters by deal or company name, case-insensitive", () => {
    expect(searchDeals("ALPHA").map((d) => d.name)).toEqual(["Alpha Lead"]);
    expect(searchDeals("zeta, inc").map((d) => d.name)).toEqual(["Zeta Active"]);
  });
});

describe("deal team resolution", () => {
  it("maps deal team to known FTV users and drops unknown ids", () => {
    expect(getDeal(DEAL_ACTIVE)!.dealTeam.map((p) => p.id)).toEqual([ALICE, BOB]);
  });

  it("tolerates malformed team JSON", () => {
    expect(getDeal("d0000000000000000000000000000005")!.dealTeam).toEqual([]);
  });
});

describe("user directory", () => {
  it("keeps only real FTV staff with a team", () => {
    const emails = listUsers().map((u) => u.email);
    expect(emails).toContain("alice@ftvcapital.com");
    expect(emails).not.toContain("support@prosapient.com"); // non-FTV domain
    expect(emails).not.toContain("noteam@ftvcapital.com"); // no team
    expect(emails).not.toContain("bad@ftvcapital.com"); // invalid id
  });

  it("looks users up by id", () => {
    expect(getUser(ALICE)?.name).toBe("Alice Associate");
    expect(getUser("nope")).toBeUndefined();
  });

  it("searchUsers matches name prefixes and strips a leading @", () => {
    expect(searchUsers("@ali").map((u) => u.name)).toEqual(["Alice Associate"]);
    expect(searchUsers("counsel")).toEqual([]); // title is not searched
    expect(searchUsers("")).toEqual([]);
  });
});
