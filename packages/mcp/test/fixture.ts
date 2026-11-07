import { createTrozu, lensAbi, marketAbi, nftAbi, vaultAbi, type Hex, type Listing } from "@trozu/sdk";
import { ADDR, announceLog, mockChain, Revert, sampleListing } from "../../sdk/test/mockChain.js";
import { createHandlers } from "../src/tools.js";

export { ADDR, sampleListing, Revert } from "../../sdk/test/mockChain.js";

export const E18 = 10n ** 18n;
export const SIG = ("0x" + "ab".repeat(65)) as Hex;
export const hashOf = (salt: bigint) => ("0x" + salt.toString(16).padStart(64, "0")) as Hex;

export interface Opts {
  /** state index `check` returns, by listing salt. Default 0, open. */
  states?: Record<string, number>;
  bufferFloorMusd?: bigint;
  positionOver?: Record<string, unknown>;
  /** makes setPolicy revert with BadPolicy(this text) */
  badPolicyText?: string;
}

/** The real SDK over a mock chain with one position (token 7, vault ADDR.vault) and a market. */
export function fixture(o: Opts = {}) {
  const m = mockChain();
  const market = m.deployment.trozu.market;
  m.contract(market, marketAbi as never, {
    check: (a) => o.states?.[String((a[0] as Listing).salt)] ?? 0,
    hashListing: (a) => hashOf((a[0] as Listing).salt),
  });
  m.contract(m.deployment.trozu.nft, nftAbi as never, { vaultOf: () => ADDR.vault, transferEpoch: () => 4n });
  m.contract(m.deployment.trozu.lens, lensAbi as never, {
    positionInfo: () => ({
      tokenId: 7n, vault: ADDR.vault, holder: ADDR.alice, active: true, coll: 2n * E18, principal: 1000n * E18, interest: 5n * E18, debt: 1005n * E18,
      priceOk: true, price: 100_000n * E18, icr: (1990n * E18) / 1000n, equity: 197_995n * E18, lockedRateBps: 450, globalRateBps: 300, spreadBps: -150n,
      annualSpreadMusd: -15n * E18, claimableSurplus: 0n, refinanceFeeEstimate: 3n * E18, redeemable: true, recoveryMode: false, canClose: true,
      ...o.positionOver,
    }),
    positionsOf: () => [3n, 7n, 9n],
    redemptionBuffer: () => ({ buffer: 1n, eligibleAhead: 100n, steps: 100n, complete: false, inList: true }),
    bufferAtLeast: () => [0, { buffer: 1n, eligibleAhead: 100n, steps: 100n, complete: false, inList: true }],
  });
  m.contract(ADDR.vault, vaultAbi as never, {
    policy: () => ({
      epoch: 1n, floorIcr: 13n * 10n ** 17n, targetIcr: 16n * 10n ** 17n, maxActionBtc: E18 / 10n, maxActionMusd: 0n, periodCapBtc: E18 / 2n, periodCapMusd: 0n,
      keeperTipBtc: 5n * 10n ** 13n, bufferFloorMusd: o.bufferFloorMusd ?? 0n, period: 86_400, maxWalkSteps: 0, active: true,
    }),
    policyLive: () => true,
    preview: () => ({ kind: 0, reason: 5, amount: 0n, tip: 0n, icr: 145n * 10n ** 16n, resetWindow: false }),
    reserveBtc: () => 3n * E18,
    reserveMusd: () => 0n,
    spentBtc: () => 0n,
    spentMusd: () => 0n,
    periodStart: () => m.state.timestamp - 100n,
    // simulate_action goes through eth_call, so the writes need an implementation too
    addCollateral: () => [],
    execute: () => [0, 0n, 0n],
    setPolicy: () => {
      if (o.badPolicyText !== undefined) throw new Revert(vaultAbi as never, "BadPolicy", [o.badPolicyText]);
      return [];
    },
  });
  const trozu = createTrozu({ client: m.client, deployment: m.deployment });
  const announce = (salt: bigint, block: bigint, over: Partial<Listing> = {}) =>
    m.state.logs.push(announceLog(market, hashOf(salt), sampleListing({ salt, ...over }), SIG, block));
  return { m, trozu, announce, h: createHandlers(trozu) };
}

/** Parses a tool result's JSON text. */
export function body(r: { content: { text: string }[] }): any {
  return JSON.parse(r.content[0]!.text);
}
