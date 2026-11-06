import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, hashTypedData, keccak256, toBytes } from "viem";
import { trozuMarketAbi } from "@/abi/trozu";
import {
  LISTING_TYPES,
  STATES,
  buildListing,
  defaultBounds,
  explainRevert,
  priceCap,
  feeOn,
  isDutch,
  marketDomain,
  marketErrorText,
  priceAt,
  priceCurve,
  stateName,
  type Listing,
} from "./market";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const A = "0x00000000000000000000000000000000000000a1" as const;
const MARKET = "0xEae6fEa26B178eF32829F36e5219363bB30D93DB" as const;

const dutch: Listing = {
  seller: A, tokenId: 7n, epoch: 1n,
  startPrice: e18(2_000), endPrice: e18(1_000),
  startTime: 1_000n, endTime: 2_000n, deadline: 5_000n, nonce: 0n, salt: 9n,
};

describe("price curve", () => {
  it("is flat for a fixed price", () => {
    const l = { ...dutch, endPrice: dutch.startPrice };
    expect(priceAt(l, 0n)).toBe(l.startPrice);
    expect(priceAt(l, 3_000n)).toBe(l.startPrice);
    expect(isDutch(l)).toBe(false);
  });
  it("falls in a straight line, and holds the end price until the deadline", () => {
    expect(priceAt(dutch, 500n)).toBe(dutch.startPrice);
    expect(priceAt(dutch, 1_000n)).toBe(dutch.startPrice);
    expect(priceAt(dutch, 1_500n)).toBe(e18(1_500));
    expect(priceAt(dutch, 2_000n)).toBe(dutch.endPrice);
    expect(priceAt(dutch, 4_999n)).toBe(dutch.endPrice);
  });
  it("rounds the drop down, so the price rounds up against the buyer", () => {
    const l = { ...dutch, startPrice: 10n, endPrice: 1n, startTime: 0n, endTime: 4n };
    // drop at t=1 is 9*1/4 = 2 (floor), price 8, never 7
    expect(priceAt(l, 1n)).toBe(8n);
    expect(isDutch(l)).toBe(true);
  });
  it("never rises over time", () => {
    let last = priceAt(dutch, 0n);
    for (let t = 0n; t <= 5_000n; t += 37n) {
      const p = priceAt(dutch, t);
      expect(p <= last).toBe(true);
      last = p;
    }
  });
  it("samples from the start to the deadline", () => {
    const c = priceCurve(dutch, 10);
    expect(c.length).toBe(11);
    expect(c[0].t).toBe(1_000);
    expect(c[10].t).toBe(5_000);
    expect(c[10].price).toBe(dutch.endPrice);
  });
});

describe("fee", () => {
  it("rounds up, so the seller's share rounds down", () => {
    expect(feeOn(10_000n, 25)).toBe(25n);
    expect(feeOn(10_001n, 25)).toBe(26n);
    expect(feeOn(1n, 25)).toBe(1n);
    expect(feeOn(100n, 0)).toBe(0n);
  });
});

describe("states", () => {
  it("lists the thirteen contract states in order", () => {
    expect(STATES.length).toBe(13);
    expect(stateName(0)).toBe("Ok");
    expect(stateName(10n)).toBe("StaleEpoch");
    expect(stateName(99)).toBe("BadParams");
  });
  it("the ABI still has the custom errors the app translates", () => {
    const errs = trozuMarketAbi.filter((x) => x.type === "error").map((x) => x.name);
    for (const n of ["ListingInvalid", "EpochMismatch", "CollateralBelowMin", "DebtAboveMax", "RateOutOfRange", "ReserveBelowMin", "PriceAboveMax", "NotSeller", "AlreadyClosed"]) {
      expect(errs).toContain(n);
    }
  });
});

describe("typed data", () => {
  it("builds the same type string as the Listing typehash written in TrozuMarket.sol", () => {
    const sig = LISTING_TYPES.Listing.map((f) => `${f.type} ${f.name}`).join(",");
    const typeHash = keccak256(toBytes(`Listing(${LISTING_TYPES.Listing.map((f) => `${f.type} ${f.name}`).join(",")})`));
    expect(sig.startsWith("address seller,uint256 tokenId,uint256 epoch")).toBe(true);
    // the string from the source, copied by hand; a live check against LISTING_TYPEHASH needs the chain
    const fromSource = keccak256(
      toBytes(
        "Listing(address seller,uint256 tokenId,uint256 epoch,uint256 startPrice,uint256 endPrice," +
          "uint64 startTime,uint64 endTime,uint64 deadline,uint256 nonce,uint256 salt)",
      ),
    );
    expect(typeHash).toBe(fromSource);
  });
  it("hashes deterministically for a domain", () => {
    const h = () => hashTypedData({ domain: marketDomain(31611, MARKET), types: LISTING_TYPES, primaryType: "Listing", message: dutch });
    expect(h()).toBe(h());
    expect(hashTypedData({ domain: marketDomain(31611, MARKET), types: LISTING_TYPES, primaryType: "Listing", message: { ...dutch, salt: 10n } })).not.toBe(h());
  });
});

describe("building a listing", () => {
  const base = { seller: A, tokenId: 7n, epoch: 1n, nonce: 0n, salt: 5n, now: 10_000n, fallSeconds: 3_600n, lifeSeconds: 86_400n } as const;
  it("builds a fixed price with a flat curve", () => {
    const r = buildListing({ ...base, kind: "fixed", startPrice: e18(1_900), endPrice: undefined });
    expect(r.errors).toEqual([]);
    expect(r.listing!.endPrice).toBe(e18(1_900));
    expect(r.listing!.deadline).toBe(10_000n + 86_400n);
  });
  it("builds a Dutch auction that bottoms out before the deadline", () => {
    const r = buildListing({ ...base, kind: "dutch", startPrice: e18(2_000), endPrice: e18(1_500) });
    expect(r.errors).toEqual([]);
    expect(r.listing!.endTime).toBe(10_000n + 3_600n);
  });
  it("refuses what check() would call BadParams", () => {
    expect(buildListing({ ...base, kind: "fixed", startPrice: undefined, endPrice: undefined }).errors.length).toBe(1);
    expect(buildListing({ ...base, kind: "dutch", startPrice: e18(1), endPrice: e18(2) }).errors.join()).toMatch(/under the starting price/);
    expect(buildListing({ ...base, kind: "dutch", startPrice: e18(2), endPrice: e18(1), fallSeconds: 0n }).errors.join()).toMatch(/take some time/);
    expect(buildListing({ ...base, kind: "dutch", startPrice: e18(2), endPrice: e18(1), fallSeconds: 90_000n }).errors.join()).toMatch(/before the listing expires/);
    expect(buildListing({ ...base, kind: "fixed", startPrice: e18(1), endPrice: undefined, lifeSeconds: 60n }).errors.join()).toMatch(/ten minutes/);
    expect(buildListing({ ...base, kind: "fixed", startPrice: e18(1), endPrice: undefined, lifeSeconds: 31n * 86_400n }).errors.join()).toMatch(/30 days/);
  });
});

describe("buyer bounds", () => {
  const seen = { epoch: 3n, coll: e18(0.05), debt: e18(1_800), rateBps: 100, reserveBtc: e18(0.01), reserveMusd: 0n };
  it("pin everything the buyer saw, with headroom only on debt", () => {
    const b = defaultBounds(seen, e18(1_900));
    expect(b.expectedEpoch).toBe(3n);
    expect(b.minColl).toBe(seen.coll);
    expect(b.maxDebt > seen.debt && b.maxDebt < seen.debt + e18(20)).toBe(true);
    expect([b.minRateBps, b.maxRateBps]).toEqual([100, 100]);
    expect(b.maxPrice).toBe(e18(1_900));
    expect(b.minReserveBtc).toBe(seen.reserveBtc);
  });
  it("has the same fields, in the same order, as the ABI's Bounds struct", () => {
    const buy = trozuMarketAbi.find((x) => x.type === "function" && x.name === "buy")!;
    const bounds = (buy as unknown as { inputs: { name: string; components?: { name: string }[] }[] }).inputs.find((i) => i.name === "b")!;
    expect(bounds.components!.map((c) => c.name)).toEqual(Object.keys(defaultBounds(seen, 1n)));
  });
});

describe("error text", () => {
  it("explains each refusal", () => {
    expect(marketErrorText("ListingInvalid", [10])).toMatch(/changed hands/);
    expect(marketErrorText("ListingInvalid", [9n])).toMatch(/withdrew the market's approval/);
    expect(marketErrorText("RateOutOfRange", [60, 100, 100])).toMatch(/0.60%/);
    expect(marketErrorText("ReserveBelowMin", [0n, 1n, 0n, 0n])).toMatch(/emptied/);
    expect(marketErrorText("Nope", [])).toBeUndefined();
  });
});

describe("revert decoding", () => {
  const revert = (errorName: string, args: unknown[]) =>
    new ContractFunctionRevertedError({
      abi: trozuMarketAbi,
      functionName: "buy",
      data: encodeErrorResult({ abi: trozuMarketAbi, errorName, args } as never),
    });
  it("turns an encoded ListingInvalid(StaleEpoch) into its sentence", () => {
    const e = new BaseError("call failed", { cause: revert("ListingInvalid", [10]) });
    expect(explainRevert(e)).toMatch(/changed hands/);
  });
  it("turns an encoded RateOutOfRange into a sentence with the rate", () => {
    const e = new BaseError("call failed", { cause: revert("RateOutOfRange", [75, 100, 100]) });
    expect(explainRevert(e)).toMatch(/0.75%/);
  });
  it("returns nothing for other errors", () => {
    expect(explainRevert(new Error("boom"))).toBeUndefined();
    expect(explainRevert(new BaseError("plain"))).toBeUndefined();
  });
});

describe("price cap", () => {
  it("is the price a minute ago, which is never below the true price", () => {
    const l = { startPrice: e18(2_000), endPrice: e18(1_000), startTime: 1_000n, endTime: 2_000n };
    expect(priceCap(l, 1_500n)).toBe(priceAt(l, 1_440n));
    expect(priceCap(l, 1_500n) >= priceAt(l, 1_500n)).toBe(true);
    expect(priceCap(l, 30n)).toBe(l.startPrice);
  });
});
