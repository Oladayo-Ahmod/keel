import { describe, expect, it } from "vitest";
import { CAP, FLOOR_SIMPLE, FLOOR_SORTED, GAS_TABLE, gasLimitFor, unmeasured } from "../src/gas.js";

describe("gas limits", () => {
  it("sends the table's literal limits", () => {
    expect(gasLimitFor("buy")).toBe(1_500_000);
    expect(gasLimitFor("execute")).toBe(6_785_885); // 5,219,911 measured plus 30%
    expect(gasLimitFor("setPolicy")).toBe(3_900_000); // 3,000,000 plus 30%
    expect(gasLimitFor("announce")).toBe(FLOOR_SIMPLE);
  });

  it("puts every call that re-sorts the trove on the sorted floor or above", () => {
    for (const f of ["openPosition", "addCollateral", "withdrawCollateral", "borrow", "repay", "refinance", "close"]) {
      expect(gasLimitFor(f)).toBeGreaterThanOrEqual(FLOOR_SORTED);
    }
  });

  it("never goes over the cap, and defenseWalk lifts only sorted calls to it", () => {
    for (const f of Object.keys(GAS_TABLE)) expect(gasLimitFor(f)).toBeLessThanOrEqual(CAP);
    expect(gasLimitFor("execute", { defenseWalk: true })).toBe(CAP);
    expect(gasLimitFor("withdrawCollateral", { defenseWalk: true })).toBe(CAP);
    expect(gasLimitFor("announce", { defenseWalk: true })).toBe(FLOOR_SIMPLE);
  });

  it("refuses a function nobody wrote an entry for", () => {
    expect(() => gasLimitFor("doSomethingNew")).toThrow(/no gas limit defined/);
  });

  it("keeps a measured limit at or above its measurement plus 30%, unless the cap bites", () => {
    for (const [name, g] of Object.entries(GAS_TABLE)) {
      if (g.basis === "measured" && g.gasUsed !== undefined) expect(g.limit, name).toBeGreaterThanOrEqual(Math.min(CAP, Math.ceil(g.gasUsed * 1.3)));
    }
  });

  it("names the unmeasured actions, which is what docs/INTEGRATIONS.md lists", () => {
    expect(unmeasured().sort()).toEqual(["cancelAll", "claimSurplus", "clearPolicy", "close", "closeWithPermit", "fundReserveMusd", "refinance", "repay", "setApprovalForAll"]);
  });
});
