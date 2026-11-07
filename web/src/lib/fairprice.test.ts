import { describe, expect, it } from "vitest";
import { fairPrice, type FairPriceInput } from "./fairprice";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const base: FairPriceInput = {
  active: true,
  priceOk: true,
  equity: e18(2_000),
  principal: e18(10_000),
  lockedRateBps: 100,
  globalRateBps: 300,
};

describe("fair price estimate", () => {
  it("adds one year of the rate advantage to equity", () => {
    const r = fairPrice(base);
    // 10,000 MUSD at a 2.00 point gap is 200 a year
    expect(r.spreadBps).toBe(200);
    expect(r.yearlyValue).toBe(e18(200));
    expect(r.premium).toBe(e18(200));
    expect(r.suggested).toBe(e18(2_200));
    expect(r.hasPremium).toBe(true);
  });

  it("agrees with the lens annualSpreadMusd formula for a positive spread", () => {
    // PositionLens: principal * (global - locked) / 10_000
    const r = fairPrice(base);
    expect(r.yearlyValue).toBe((base.principal * BigInt(base.globalRateBps - base.lockedRateBps)) / 10_000n);
  });

  it("scales the premium with the horizon", () => {
    expect(fairPrice({ ...base, years: 0.5 }).premium).toBe(e18(100));
    expect(fairPrice({ ...base, years: 2 }).suggested).toBe(e18(2_400));
  });

  it("gives no premium when the spread is zero", () => {
    const r = fairPrice({ ...base, globalRateBps: 100 });
    expect(r.hasPremium).toBe(false);
    expect(r.yearlyValue).toBe(0n);
    expect(r.suggested).toBe(e18(2_000));
    expect(r.dutch).toBeUndefined();
    expect(r.note).toMatch(/equals the market rate/);
  });

  it("gives no premium and no discount when the locked rate is above the market", () => {
    const r = fairPrice({ ...base, lockedRateBps: 500, globalRateBps: 300 });
    expect(r.spreadBps).toBe(-200);
    expect(r.hasPremium).toBe(false);
    expect(r.premium).toBe(0n);
    expect(r.suggested).toBe(e18(2_000));
    expect(r.note).toMatch(/above the market rate/);
  });

  it("counts the guardian reserve at the BTC price", () => {
    const r = fairPrice({ ...base, reserveBtc: e18(0.01), reserveMusd: e18(50), btcPrice: e18(80_000) });
    // 0.01 BTC at 80,000 is 800, plus 50 MUSD
    expect(r.reserveValue).toBe(e18(850));
    expect(r.baseValue).toBe(e18(2_850));
    expect(r.suggested).toBe(e18(3_050));
  });

  it("offers a falling price from the suggestion to the base value, only with a premium", () => {
    const r = fairPrice(base);
    expect(r.dutch).toEqual({ start: e18(2_200), end: e18(2_000) });
  });

  it("rounds down to a whole cent", () => {
    const r = fairPrice({ ...base, equity: 2_000n * 10n ** 18n + 123_456_789n, principal: 1n, globalRateBps: 100 });
    expect(r.suggested % 10n ** 16n).toBe(0n);
    expect(r.suggested).toBe(e18(2_000));
  });

  it("does not suggest anything when the price feed is down", () => {
    const r = fairPrice({ ...base, priceOk: false });
    expect(r.available).toBe(false);
    expect(r.suggested).toBe(0n);
    expect(r.reason).toMatch(/price feed/);
  });

  it("does not suggest anything for a closed position", () => {
    expect(fairPrice({ ...base, active: false }).available).toBe(false);
  });

  it("treats negative equity as zero and still prices the rate advantage", () => {
    const r = fairPrice({ ...base, equity: -e18(300) });
    expect(r.baseValue).toBe(0n);
    expect(r.available).toBe(true);
    expect(r.suggested).toBe(e18(200));
    // an auction needs a positive lowest price, so none is offered
    expect(r.dutch).toBeUndefined();
  });

  it("has nothing to suggest when equity is negative and the spread is not positive", () => {
    const r = fairPrice({ ...base, equity: -e18(300), globalRateBps: 100 });
    expect(r.available).toBe(false);
    expect(r.suggested).toBe(0n);
  });

  it("lets reserve cover negative equity", () => {
    const r = fairPrice({ ...base, equity: -e18(100), globalRateBps: 100, reserveMusd: e18(400) });
    expect(r.baseValue).toBe(e18(300));
    expect(r.suggested).toBe(e18(300));
  });
});
