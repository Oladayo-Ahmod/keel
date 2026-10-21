import { describe, expect, it } from "vitest";
import { computeHints, nicrAfterOpen, type ReadClient } from "./hints";
import { APP_MIN_ICR, collForIcr, parseAmount, planOpen } from "./open";
import { friendlyError } from "./errors";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("nicrAfterOpen", () => {
  it("matches the value measured on matsnet", () => {
    // 0.036 BTC against 1800 MUSD debt, fee 1.8, reserve 200: verified in docs/VERIFICATION.md
    expect(nicrAfterOpen(e18(0.036), e18(1800), e18(1.8))).toBe(1_798_381_456_688_979n);
  });
});

describe("computeHints", () => {
  it("asks for an approximate hint first, then the insert position, and returns the pair", async () => {
    const calls: string[] = [];
    const client: ReadClient = {
      readContract: async ({ functionName, args }) => {
        calls.push(functionName);
        if (functionName === "getApproxHint") return ["0x00000000000000000000000000000000000000a1", 0n, 7n];
        // the approximate hint is passed on as both neighbours
        expect(args[1]).toBe("0x00000000000000000000000000000000000000a1");
        expect(args[2]).toBe("0x00000000000000000000000000000000000000a1");
        return ["0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2"];
      },
    };
    const hints = await computeHints(client, 123n, 5n);
    expect(calls).toEqual(["getApproxHint", "findInsertPosition"]);
    expect(hints).toEqual(["0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2"]);
  });

  it("recomputes on every call, nothing is cached", async () => {
    let n = 0;
    const client: ReadClient = {
      readContract: async ({ functionName }) => {
        n++;
        return functionName === "getApproxHint" ? ["0x00000000000000000000000000000000000000a1", 0n, 0n] : ["0x0", "0x0"];
      },
    };
    await computeHints(client, 1n, 1n);
    await computeHints(client, 1n, 1n);
    expect(n).toBe(4);
  });
});

describe("parseAmount", () => {
  it("accepts plain decimals", () => {
    expect(parseAmount("1.5")).toBe(e18(1.5));
    expect(parseAmount(" 0.039 ")).toBe(e18(0.039));
    expect(parseAmount(".5")).toBe(e18(0.5));
  });
  it("rejects anything else", () => {
    for (const bad of ["", ".", "abc", "-1", "1e3", "0", "0.0", "1.2.3", "1,5"]) {
      expect(parseAmount(bad)).toBeUndefined();
    }
  });
});

describe("planOpen", () => {
  const base = { price: e18(82_000), fee: e18(1.8), minNetDebt: e18(1800), balance: e18(1) };

  it("computes ICR and equity from the composite debt", () => {
    const coll = collForIcr(e18(1800), e18(1.8), base.price, e18(1.6));
    const plan = planOpen({ ...base, debt: e18(1800), coll });
    expect(plan.composite).toBe(e18(2001.8));
    expect(plan.icr).toBeGreaterThanOrEqual(e18(1.6));
    expect(plan.icr).toBeLessThan(e18(1.6001));
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.equity).toBeGreaterThan(0n);
  });

  it("blocks under the app floor and warns under 150%", () => {
    const low = planOpen({ ...base, debt: e18(1800), coll: collForIcr(e18(1800), e18(1.8), base.price, e18(1.15)) });
    expect(low.errors.join(" ")).toMatch(/at least 120%/);
    const mid = planOpen({ ...base, debt: e18(1800), coll: collForIcr(e18(1800), e18(1.8), base.price, e18(1.3)) });
    expect(mid.errors).toEqual([]);
    expect(mid.warnings.join(" ")).toMatch(/150%/);
    expect(APP_MIN_ICR).toBe(e18(1.2));
  });

  it("enforces the minimum net debt", () => {
    const plan = planOpen({ ...base, debt: e18(1000), coll: e18(0.05) });
    expect(plan.errors.join(" ")).toMatch(/minimum is 1,800\.00 MUSD/);
  });

  it("keeps a gas reserve in the wallet", () => {
    const coll = collForIcr(e18(1800), e18(1.8), base.price, e18(1.6));
    const plan = planOpen({ ...base, debt: e18(1800), coll, balance: coll + 1n });
    expect(plan.errors.join(" ")).toMatch(/Not enough BTC/);
  });

  it("refuses when the price is missing", () => {
    expect(planOpen({ ...base, price: 0n, debt: e18(1800), coll: e18(0.04) }).errors.join(" ")).toMatch(/price feed/);
  });
});

describe("collForIcr", () => {
  it("never lands under the target", () => {
    for (const icr of [1.2, 1.5, 1.6, 2.5]) {
      for (const price of [30_000, 82_123.456, 150_000]) {
        const p = e18(price);
        const coll = collForIcr(e18(1800), e18(1.8), p, e18(icr));
        const plan = planOpen({ debt: e18(1800), coll, price: p, fee: e18(1.8), minNetDebt: 0n, balance: e18(10) });
        expect(plan.icr).toBeGreaterThanOrEqual(e18(icr));
      }
    }
  });
});

describe("friendlyError", () => {
  it("recognises a wallet rejection, however it is wrapped", () => {
    expect(friendlyError({ name: "UserRejectedRequestError" }).rejected).toBe(true);
    expect(friendlyError({ message: "x", cause: { code: 4001 } }).rejected).toBe(true);
    expect(friendlyError(new Error("User rejected the request.")).rejected).toBe(true);
  });
  it("explains common failures", () => {
    expect(friendlyError({ shortMessage: "insufficient funds for gas" }).message).toMatch(/enough BTC/);
    expect(friendlyError({ message: "BorrowerOps: An operation that would result in TCR < CCR is not permitted" }).message).toMatch(/150%/);
    expect(friendlyError({ message: "reverted with ERC721InvalidReceiver" }).message).toMatch(/cannot hold NFTs/);
  });
  it("falls back to the first line", () => {
    const f = friendlyError({ shortMessage: "something odd\nwith details" });
    expect(f).toEqual({ message: "something odd", rejected: false });
  });
});
