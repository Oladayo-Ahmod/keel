import { describe, expect, it } from "vitest";
import { config } from "@/config";
import { isRisky, receiverProblem } from "./transfer";

const vault = "0x1D5acd83cd4D87F26533A364394e206199af7464";
const me = "0x5104C1A69242D94159Cf7151277252e568cB8F98";
const other = "0x1111111111111111111111111111111111111111";
const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("receiverProblem", () => {
  it("accepts an ordinary address", () => {
    expect(receiverProblem(other, me, { vault })).toBeUndefined();
    expect(receiverProblem(`  ${other}  `, me, { vault })).toBeUndefined();
  });

  it("rejects the things that lose a position", () => {
    expect(receiverProblem("", me, { vault })).toMatch(/Enter/);
    expect(receiverProblem("0x123", me, { vault })).toMatch(/not a valid/);
    expect(receiverProblem("0x0000000000000000000000000000000000000000", me, { vault })).toMatch(/burn/);
    expect(receiverProblem(me.toLowerCase(), me, { vault })).toMatch(/your own/);
    expect(receiverProblem(vault, me, { vault })).toMatch(/protocol contract/);
    expect(receiverProblem(config.keel.nft, me, { vault })).toMatch(/protocol contract/);
    expect(receiverProblem(config.mezo.musd, me, { vault })).toMatch(/protocol contract/);
  });
});

describe("isRisky", () => {
  const base = { vault, active: true, priceOk: true, equity: e18(1000), icr: e18(1.6) };
  it("lets a healthy position through without the typed word", () => {
    expect(isRisky(base)).toBe(false);
  });
  it("flags underwater, low ratio and unknown price", () => {
    expect(isRisky({ ...base, equity: -1n })).toBe(true);
    expect(isRisky({ ...base, equity: 0n })).toBe(true);
    expect(isRisky({ ...base, icr: e18(1.2) })).toBe(true);
    expect(isRisky({ ...base, priceOk: false })).toBe(true);
  });
  it("does not flag a closed trove or a position with no debt", () => {
    expect(isRisky({ ...base, active: false, equity: -5n })).toBe(false);
    expect(isRisky({ ...base, icr: 2n ** 256n - 1n })).toBe(false);
  });
});
