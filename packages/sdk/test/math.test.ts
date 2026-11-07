import { describe, expect, it } from "vitest";
import { defaultBounds, feeOn, icrOf, icrPercent, NO_DEBT_ICR, priceAt, remaining, riskOf, validatePolicy, windowFresh } from "../src/math.js";
import { TrozuValidationError } from "../src/errors.js";
import type { PolicyInput } from "../src/types.js";

const E18 = 10n ** 18n;
const l = { startPrice: 1000n * E18, endPrice: 800n * E18, startTime: 100n, endTime: 200n };

describe("priceAt", () => {
  it("holds the start price until the start and the end price from the end", () => {
    expect(priceAt(l, 0n)).toBe(l.startPrice);
    expect(priceAt(l, 100n)).toBe(l.startPrice);
    expect(priceAt(l, 200n)).toBe(l.endPrice);
    expect(priceAt(l, 9_999n)).toBe(l.endPrice);
  });

  it("falls in a straight line", () => {
    expect(priceAt(l, 150n)).toBe(900n * E18);
  });

  it("rounds the drop down, so the price rounds up against the buyer", () => {
    // a 1 wei drop over 3 seconds: after 1 second the drop is 0.33 wei, rounded down to 0
    const odd = { startPrice: 11n, endPrice: 10n, startTime: 0n, endTime: 3n };
    expect(priceAt(odd, 1n)).toBe(11n);
    expect(priceAt(odd, 2n)).toBe(11n);
    expect(priceAt(odd, 3n)).toBe(10n);
  });

  it("is flat for a fixed price", () => {
    expect(priceAt({ startPrice: 5n, endPrice: 5n, startTime: 0n, endTime: 0n }, 12n)).toBe(5n);
  });

  it("throws, like the contract reverts, when the end price is above the start price mid-curve", () => {
    expect(() => priceAt({ startPrice: 1n, endPrice: 9n, startTime: 0n, endTime: 10n }, 5n)).toThrow(TrozuValidationError);
  });
});

describe("feeOn", () => {
  it("rounds up", () => {
    expect(feeOn(10_000n, 25)).toBe(25n);
    expect(feeOn(10_001n, 25)).toBe(26n);
    expect(feeOn(1n, 25)).toBe(1n);
    expect(feeOn(0n, 25)).toBe(0n);
  });
});

describe("risk", () => {
  const at = (pct: bigint, active = true) => riskOf({ active, icr: (pct * E18) / 100n });
  it("labels the ratio bands", () => {
    expect(at(200n)).toBe("safe");
    expect(at(150n)).toBe("safe");
    expect(at(149n)).toBe("caution");
    expect(at(125n)).toBe("caution");
    expect(at(124n)).toBe("danger");
    expect(at(110n)).toBe("danger");
    expect(at(109n)).toBe("liquidatable");
  });
  it("says none for a position with no trove, and safe for no debt", () => {
    expect(at(200n, false)).toBe("none");
    expect(riskOf({ active: true, icr: 2n ** 256n - 1n })).toBe("safe");
  });
  it("turns a ratio into percent, and the no-debt sentinel into null", () => {
    expect(icrPercent((1605n * E18) / 1000n)).toBe(160.5);
    expect(icrPercent(NO_DEBT_ICR)).toBeNull();
  });
  it("works out the ratio from collateral, price and debt", () => {
    expect(icrOf(2n * E18, 1000n * E18, 100_000n * E18)).toBe(200n * E18);
    expect(icrOf(1n, 0n, 1n)).toBeUndefined();
    expect(icrOf(1n, 1n, 0n)).toBeUndefined();
  });
});

describe("validatePolicy", () => {
  const ok: PolicyInput = {
    floorIcr: 13n * 10n ** 17n,
    targetIcr: 16n * 10n ** 17n,
    maxActionBtc: E18 / 10n,
    maxActionMusd: 0n,
    periodCapBtc: E18 / 2n,
    periodCapMusd: 0n,
    keeperTipBtc: 5n * 10n ** 13n,
    bufferFloorMusd: 0n,
    period: 86_400,
    maxWalkSteps: 0,
  };
  it("passes a sensible policy", () => {
    expect(validatePolicy(ok)).toEqual([]);
  });
  it("catches every rule the vault enforces", () => {
    expect(validatePolicy({ ...ok, floorIcr: 11n * 10n ** 17n })).toHaveLength(1);
    expect(validatePolicy({ ...ok, targetIcr: ok.floorIcr })).toHaveLength(1);
    expect(validatePolicy({ ...ok, targetIcr: 6n * E18 }).join()).toMatch(/500%/);
    expect(validatePolicy({ ...ok, period: 60 }).join()).toMatch(/period/);
    expect(validatePolicy({ ...ok, keeperTipBtc: 10n ** 15n }).join()).toMatch(/tip/);
    expect(validatePolicy({ ...ok, maxActionBtc: 0n }).join()).toMatch(/at least one|allow/);
    expect(validatePolicy({ ...ok, maxActionBtc: E18 }).join()).toMatch(/period cap/);
    expect(validatePolicy({ ...ok, keeperTipBtc: ok.periodCapBtc }).join()).toMatch(/below periodCapBtc/);
    expect(validatePolicy({ ...ok, maxWalkSteps: 101 }).join()).toMatch(/100/);
    expect(validatePolicy({ ...ok, bufferFloorMusd: 1n }).join()).toMatch(/defense/);
  });
});

describe("allowance helpers and bounds", () => {
  it("never goes negative and notices a rolled window", () => {
    expect(remaining(10n, 4n)).toBe(6n);
    expect(remaining(10n, 12n)).toBe(0n);
    expect(windowFresh(100n, 50, 149n)).toBe(false);
    expect(windowFresh(100n, 50, 150n)).toBe(true);
  });
  it("signs up to what was seen, with headroom only on debt", () => {
    const b = defaultBounds({ epoch: 3n, coll: 5n, debt: 2_000n, rateBps: 120, reserveBtc: 7n, reserveMusd: 9n }, 42n);
    expect(b).toEqual({ expectedEpoch: 3n, minColl: 5n, maxDebt: 2_011n, minRateBps: 120, maxRateBps: 120, maxPrice: 42n, minReserveBtc: 7n, minReserveMusd: 9n });
  });
});
