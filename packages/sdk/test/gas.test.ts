import { describe, expect, it } from "vitest";
import { CAP, FLOOR_SIMPLE, FLOOR_SORTED, GAS_RULES, gasLimitFor } from "../src/gas.js";

describe("gas limits", () => {
  it("takes the larger of measured plus 30% and the floor", () => {
    expect(gasLimitFor("buy")).toBe(1_500_000); // 276,848 * 1.3 is under the floor
    expect(gasLimitFor("execute")).toBe(6_785_885); // 5,219,911 * 1.3 rounded up, over the sorted floor
    expect(gasLimitFor("announce")).toBe(FLOOR_SIMPLE);
  });

  it("puts every call that re-sorts the trove on the sorted floor", () => {
    for (const f of ["openPosition", "addCollateral", "withdrawCollateral", "borrow", "repay", "refinance", "close"]) {
      expect(gasLimitFor(f)).toBeGreaterThanOrEqual(FLOOR_SORTED);
    }
  });

  it("never goes over the cap, and defenseWalk lifts sorted calls to it", () => {
    for (const f of Object.keys(GAS_RULES)) expect(gasLimitFor(f)).toBeLessThanOrEqual(CAP);
    expect(gasLimitFor("execute", { defenseWalk: true })).toBe(CAP);
    expect(gasLimitFor("withdrawCollateral", { defenseWalk: true })).toBe(CAP);
    // a call that never touches the sorted list is not changed by it
    expect(gasLimitFor("announce", { defenseWalk: true })).toBe(FLOOR_SIMPLE);
  });

  it("refuses a function nobody wrote a rule for", () => {
    expect(() => gasLimitFor("doSomethingNew")).toThrow(/no gas limit defined/);
  });
});
