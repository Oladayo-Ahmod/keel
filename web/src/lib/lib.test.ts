import { describe, expect, it } from "vitest";
import { fixed, formatBps, formatBtc, formatIcr, formatMusd, formatSignedBps, shortAddress } from "./format";
import { gaugeFraction, riskOf } from "./risk";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("format", () => {
  it("truncates instead of rounding up", () => {
    expect(fixed(1_999_999_999_999_999_999n, 2)).toBe("1.99");
  });

  it("groups thousands", () => {
    expect(formatMusd(e18(1234567.891))).toBe("1,234,567.89");
  });

  it("pads decimals", () => {
    expect(formatBtc(e18(0.5))).toBe("0.50000");
  });

  it("keeps the sign and hides negative zero", () => {
    expect(fixed(-e18(2.5), 2)).toBe("-2.50");
    expect(fixed(-1n, 2)).toBe("0.00");
  });

  it("formats icr as a percentage", () => {
    expect(formatIcr(e18(1.6013))).toBe("160.1%");
    expect(formatIcr(2n ** 256n - 1n)).toBe("no debt");
  });

  it("formats rates", () => {
    expect(formatBps(100)).toBe("1.00%");
    expect(formatBps(5)).toBe("0.05%");
    expect(formatSignedBps(-60)).toBe("-0.60 pts");
    expect(formatSignedBps(200)).toBe("+2.00 pts");
    expect(formatSignedBps(0)).toBe("0.00 pts");
  });

  it("shortens addresses", () => {
    expect(shortAddress("0x1D5acd83cd4D87F26533A364394e206199af7464")).toBe("0x1D5a…7464");
  });
});

describe("risk", () => {
  it("classifies by the Mezo thresholds", () => {
    expect(riskOf(e18(1.6), true).level).toBe("safe");
    expect(riskOf(e18(1.5), true).level).toBe("safe");
    expect(riskOf(e18(1.3), true).level).toBe("caution");
    expect(riskOf(e18(1.2), true).level).toBe("danger");
    expect(riskOf(e18(1.09), true).label).toBe("Liquidatable");
  });

  it("treats a closed trove as having no risk level", () => {
    expect(riskOf(0n, false).level).toBe("none");
  });

  it("never reports healthy for stale data, whatever the ratio", () => {
    for (const icr of [e18(0.5), e18(1.2), e18(1.6), e18(5), 2n ** 256n - 1n]) {
      const r = riskOf(icr, true, true);
      expect(r.level).toBe("stale");
      expect(r.label).toBe("Stale data");
    }
  });

  it("maps the gauge range", () => {
    expect(gaugeFraction(1.0)).toBe(0);
    expect(gaugeFraction(2.5)).toBe(1);
    expect(gaugeFraction(1.75)).toBeCloseTo(0.5);
    expect(gaugeFraction(0.5)).toBe(0);
    expect(gaugeFraction(9)).toBe(1);
    expect(gaugeFraction(Infinity)).toBe(1);
  });
});
