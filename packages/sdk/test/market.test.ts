import { describe, expect, it } from "vitest";
import { createTrozu, LOG_WINDOW } from "../src/index.js";
import { lensAbi, marketAbi, nftAbi, vaultAbi } from "../src/generated/abis.js";
import type { Hex, Listing } from "../src/types.js";
import { ADDR, announceLog, mockChain, sampleListing } from "./mockChain.js";

const E18 = 10n ** 18n;
const SIG = ("0x" + "ab".repeat(65)) as Hex;
const hashOf = (salt: bigint) => ("0x" + salt.toString(16).padStart(64, "0")) as Hex;

function setup(states: Record<string, number> = {}) {
  const m = mockChain();
  const market = m.deployment.trozu.market;
  m.contract(market, marketAbi as never, {
    check: (a) => states[String((a[0] as Listing).salt)] ?? 0,
    hashListing: (a) => hashOf((a[0] as Listing).salt),
  });
  m.contract(m.deployment.trozu.nft, nftAbi as never, { vaultOf: () => ADDR.vault, transferEpoch: () => 4n });
  m.contract(m.deployment.trozu.lens, lensAbi as never, {
    positionInfo: () => ({
      tokenId: 7n, vault: ADDR.vault, holder: ADDR.alice, active: true, coll: 2n * E18, principal: 1000n * E18, interest: 0n, debt: 1_000n * E18,
      priceOk: true, price: 100_000n * E18, icr: 200n * E18, equity: 0n, lockedRateBps: 450, globalRateBps: 300, spreadBps: 150n,
      annualSpreadMusd: 0n, claimableSurplus: 0n, refinanceFeeEstimate: 0n, redeemable: true, recoveryMode: false, canClose: true,
    }),
  });
  m.contract(ADDR.vault, vaultAbi as never, { reserveBtc: () => 7n, reserveMusd: () => 9n });
  const announce = (salt: bigint, block: bigint, over: Partial<Listing> = {}) =>
    m.state.logs.push(announceLog(market, hashOf(salt), sampleListing({ salt, ...over }), SIG, block));
  return { m, trozu: createTrozu({ client: m.client, deployment: m.deployment }), announce };
}

describe("listings", () => {
  it("returns announcements newest first, each with the market's own verdict and the price now", async () => {
    const { trozu, announce } = setup({ "2": 5 }); // salt 2 has expired
    announce(1n, 16_699_000n);
    announce(2n, 16_699_500n);
    const out = await trozu.market.listings();
    expect(out.map((l) => l.listing.salt)).toEqual([2n, 1n]);
    expect(out[0]).toMatchObject({ state: "Expired", open: false });
    expect(out[1]).toMatchObject({ state: "Ok", open: true, dutch: true });
    // chain time 1,800,000,000 is halfway down the 1,000 second curve from 1,000 to 800
    expect(out[1]?.priceNow).toBe(900n * E18);
    expect(out[1]?.feeNow).toBe((900n * E18 * 25n + 9_999n) / 10_000n);
    expect(out[1]?.sellerReceives).toBe(900n * E18 - (out[1]?.feeNow ?? 0n));
    expect(out[1]?.announcedAtBlock).toBe(16_699_000n);
  });

  it("keeps only open listings on request", async () => {
    const { trozu, announce } = setup({ "1": 1, "2": 2 });
    announce(1n, 16_699_000n);
    announce(2n, 16_699_100n);
    announce(3n, 16_699_200n);
    const out = await trozu.market.listings({ onlyOpen: true });
    expect(out.map((l) => l.listing.salt)).toEqual([3n]);
  });

  it("asks the node for logs in windows no bigger than the public RPC allows", async () => {
    const { m, trozu, announce } = setup();
    announce(1n, 16_690_000n);
    announce(2n, 16_660_000n);
    const out = await trozu.market.listings({ lookbackBlocks: 50_000 });
    expect(out).toHaveLength(2);
    const windows = m.requests.filter((r) => r.method === "eth_getLogs").map((r) => {
      const f = (r.params as { fromBlock: Hex; toBlock: Hex }[])[0]!;
      return BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
    });
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w).toBeLessThanOrEqual(LOG_WINDOW);
  });

  it("never looks before the market existed", async () => {
    const { m, trozu } = setup();
    await trozu.market.listings({ lookbackBlocks: 2_000_000 });
    const froms = m.requests.filter((r) => r.method === "eth_getLogs").map((r) => BigInt((r.params as { fromBlock: Hex }[])[0]!.fromBlock));
    expect(Math.min(...froms.map(Number))).toBeGreaterThanOrEqual(m.deployment.deployedAtBlock);
  });

  it("filters by position, skips repeats of one announcement, and honours the limit", async () => {
    const { trozu, announce } = setup();
    announce(1n, 16_699_000n, { tokenId: 7n });
    announce(1n, 16_699_001n, { tokenId: 7n }); // the same hash announced twice
    announce(2n, 16_699_002n, { tokenId: 8n });
    announce(3n, 16_699_003n, { tokenId: 7n });
    expect((await trozu.market.listings({ tokenId: 7n })).map((l) => l.listing.salt)).toEqual([3n, 1n]);
    expect(await trozu.market.listings({ limit: 1 })).toHaveLength(1);
  });

  it("gives no price for a listing whose own numbers are nonsense, and does not throw", async () => {
    const { trozu, announce } = setup({ "9": 3 }); // BadParams
    announce(9n, 16_699_000n, { startPrice: 1n, endPrice: 10n ** 30n });
    const [l] = await trozu.market.listings();
    expect(l).toMatchObject({ state: "BadParams", open: false, priceNow: null, feeNow: null, sellerReceives: null });
  });

  it("bounds the work a flood of announcements can cause", async () => {
    const { m, trozu, announce } = setup();
    for (let i = 1n; i <= 600n; i++) announce(i, 16_699_000n + i);
    const out = await trozu.market.listings({ limit: 200, maxScan: 40 });
    expect(out).toHaveLength(40);
    const checks = m.requests.filter((r) => r.method === "eth_call").length;
    expect(checks).toBe(40);
  });

  it("clamps silly option values instead of trusting them", async () => {
    const { trozu, announce } = setup();
    announce(1n, 16_700_000n); // the latest block, the only one a clamped lookback of one block can see
    announce(2n, 16_699_999n);
    // limit and maxScan clamp up to one, the lookback to one block
    const out = await trozu.market.listings({ limit: -5, lookbackBlocks: 0, maxScan: 0 });
    expect(out.map((l) => l.listing.salt)).toEqual([1n]);
  });
});

describe("quote", () => {
  it("prices a listing now and works out the bounds a careful buyer would sign", async () => {
    const { trozu } = setup();
    const q = await trozu.market.quote(sampleListing(), SIG);
    expect(q).toMatchObject({ state: "Ok", open: true, price: 900n * E18, hash: hashOf(5n) });
    expect(q.bounds).toEqual({
      expectedEpoch: 4n,
      minColl: 2n * E18,
      maxDebt: 1_000n * E18 + 5n * E18 + 1n,
      minRateBps: 450,
      maxRateBps: 450,
      maxPrice: 900n * E18,
      minReserveBtc: 7n,
      minReserveMusd: 9n,
    });
    expect(q.position?.tokenId).toBe(7n);
  });

  it("still quotes a listing that cannot be bought, and says why", async () => {
    const { trozu } = setup({ "5": 8 }); // NotOwner
    const q = await trozu.market.quote(sampleListing(), SIG);
    expect(q.state).toBe("NotOwner");
    expect(q.open).toBe(false);
  });

  it("returns no bounds for a listing with a nonsense price", async () => {
    const { trozu } = setup({ "5": 3 });
    const q = await trozu.market.quote(sampleListing({ startPrice: 1n, endPrice: 10n ** 30n }), SIG);
    expect(q.price).toBeNull();
    expect(q.bounds).toBeUndefined();
  });
});
