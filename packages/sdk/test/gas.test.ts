import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAP, FLOOR_SIMPLE, FLOOR_SORTED, GAS_TABLE, gasLimitFor, unmeasured } from "../src/gas.js";

const record = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "gas-measurements.json"), "utf8")) as Record<string, { minGas: number }>;
const NINE = ["repay", "refinance", "close", "closeWithPermit", "claimSurplus", "fundReserveMusd", "clearPolicy", "cancelAll", "setApprovalForAll"];

describe("gas limits", () => {
  it("sends the table's literal limits", () => {
    expect(gasLimitFor("buy")).toBe(1_500_000);
    expect(gasLimitFor("execute")).toBe(6_785_885); // 5,219,911 measured plus 30%
    expect(gasLimitFor("setPolicy")).toBe(3_900_000); // 3,000,000 plus 30%
    expect(gasLimitFor("announce")).toBe(FLOOR_SIMPLE);
  });

  it("puts every call that re-sorts the trove on the sorted floor or above", () => {
    for (const f of ["openPosition", "addCollateral", "withdrawCollateral", "borrow"]) {
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

  it("leaves no action unmeasured", () => {
    expect(unmeasured()).toEqual([]);
  });

  it("measures the nine former gaps from docs/gas-measurements.json, and sends about twice the minimum", () => {
    for (const f of NINE) {
      const g = GAS_TABLE[f]!;
      expect(g.basis, f).toBe("measured");
      expect(g.gasUsed, f).toBe(record[f]!.minGas);
      expect(g.source, f).toBe("docs/gas-measurements.json");
      expect(g.limit, f).toBeGreaterThanOrEqual(2 * record[f]!.minGas);
      expect(g.limit, f).toBeLessThan(2 * record[f]!.minGas + 5_000);
    }
  });

  it("uses the cap for repay and refinance when the caller gives no hints, which cost about 3.5M, and never otherwise", () => {
    expect(record["repay (no hints)"]!.minGas).toBeGreaterThan(3_000_000);
    expect(record["refinance (no hints)"]!.minGas).toBeGreaterThan(3_000_000);
    for (const f of ["repay", "refinance"]) {
      expect(gasLimitFor(f, { hinted: false }), f).toBe(CAP);
      expect(gasLimitFor(f, { hinted: true }), f).toBe(gasLimitFor(f));
      expect(gasLimitFor(f, { hinted: false }), f).toBeGreaterThan(2 * record[`${f} (no hints)`]!.minGas);
    }
    expect(gasLimitFor("close", { hinted: false })).toBe(gasLimitFor("close"));
  });
});
