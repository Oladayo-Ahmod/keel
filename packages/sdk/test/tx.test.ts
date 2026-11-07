import { decodeFunctionData, zeroHash, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import { matsnet } from "../src/client.js";
import { TrozuValidationError } from "../src/errors.js";
import { gasLimitFor } from "../src/gas.js";
import { factoryAbi, marketAbi, nftAbi, vaultAbi } from "../src/generated/abis.js";
import { txBuilders } from "../src/tx.js";
import type { PolicyInput, UnsignedTx } from "../src/types.js";
import { ADDR, sampleListing } from "./mockChain.js";

const tx = txBuilders(matsnet);
const E18 = 10n ** 18n;
const vault = ADDR.vault;
const zero = "0x0000000000000000000000000000000000000000";
const decode = (t: UnsignedTx, abi: Abi) => decodeFunctionData({ abi, data: t.data });

const policy: PolicyInput = {
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

describe("every builder returns only unsigned fields with an explicit gas limit", () => {
  const all: UnsignedTx[] = [
    tx.openPosition({ debt: 2_000n * E18, collateral: E18, maxFee: 20n * E18 }),
    tx.addCollateral({ vault, amount: E18 }),
    tx.withdrawCollateral({ vault, amount: E18 }),
    tx.borrow({ vault, amount: E18, maxFee: E18 }),
    tx.repay({ vault, amount: E18, hints: [ADDR.alice, ADDR.bob] }),
    tx.repayWithPermit({ vault, amount: E18, permit: { deadline: 9n, v: 27, r: zeroHash, s: zeroHash } }),
    tx.refinance({ vault, maxFee: E18, hints: [ADDR.alice, ADDR.bob] }),
    tx.close({ vault }),
    tx.closeWithPermit({ vault, permit: { deadline: 9n, v: 27, r: zeroHash, s: zeroHash } }),
    tx.claimSurplus({ vault }),
    tx.sweep({ vault, token: ADDR.bob }),
    tx.setPolicy({ vault, policy }),
    tx.clearPolicy({ vault }),
    tx.fundReserveBtc({ vault, amount: E18 }),
    tx.fundReserveMusd({ vault, amount: E18 }),
    tx.fundReserveMusdWithPermit({ vault, amount: E18, permit: { deadline: 9n, v: 27, r: zeroHash, s: zeroHash } }),
    tx.withdrawReserveBtc({ vault, amount: E18 }),
    tx.withdrawReserveMusd({ vault, amount: E18 }),
    tx.execute({ vault }),
    tx.approveMusd({ spender: vault, amount: E18 }),
    tx.approveMarketFor({ tokenId: 7n }),
    tx.transferPosition({ from: ADDR.alice, to: ADDR.bob, tokenId: 7n }),
    tx.announce({ listing: sampleListing(), signature: "0x" + "ab".repeat(65) as `0x${string}` }),
    tx.cancel({ listing: sampleListing() }),
    tx.cancelAll(),
  ];

  it("has chain id, target, calldata, value, gas and nothing that could be a key or signature of the transaction", () => {
    for (const t of all) {
      expect(Object.keys(t).sort()).toEqual(["chainId", "data", "functionName", "gas", "summary", "to", "value"]);
      expect(t.chainId).toBe(31611);
      expect(t.gas).toBeGreaterThan(0n);
      expect(t.gas).toBe(BigInt(gasLimitFor(t.functionName)));
      expect(t.data).toMatch(/^0x[0-9a-f]{8}/);
    }
  });
});

describe("the limit follows the hints", () => {
  const hints = [ADDR.alice, ADDR.bob] as const;
  const ZERO = "0x0000000000000000000000000000000000000000" as const;

  it("is about twice the measured minimum with hints, and the cap without them, for repay and refinance", () => {
    expect(tx.repay({ vault, amount: E18, hints }).gas).toBe(880_000n);
    expect(tx.refinance({ vault, maxFee: E18, hints }).gas).toBe(880_000n);
    expect(tx.repay({ vault, amount: E18 }).gas).toBe(9_500_000n);
    expect(tx.refinance({ vault, maxFee: E18 }).gas).toBe(9_500_000n);
  });

  it("treats zero-address hints as no hints", () => {
    expect(tx.repay({ vault, amount: E18, hints: [ZERO, ZERO] }).gas).toBe(9_500_000n);
    expect(tx.repay({ vault, amount: E18, hints: [ADDR.alice, ZERO] }).gas).toBe(880_000n);
  });

  it("still lifts a hinted call to the cap when a redemption-defense walk is on", () => {
    expect(tx.repay({ vault, amount: E18, hints, gas: { defenseWalk: true } }).gas).toBe(9_500_000n);
  });

  it("does not change the limit of a call that takes no hints", () => {
    expect(tx.close({ vault }).gas).toBe(895_000n);
    expect(tx.cancelAll().gas).toBe(95_000n);
  });
});

describe("encoding", () => {
  it("opens a position through the factory with the collateral as the value", () => {
    const t = tx.openPosition({ debt: 2_000n * E18, collateral: E18, maxFee: 20n * E18 });
    expect(t.to).toBe(matsnet.trozu.factory);
    expect(t.value).toBe(E18);
    const d = decode(t, factoryAbi);
    expect(d.functionName).toBe("openPosition");
    expect(d.args).toEqual([2_000n * E18, zero, zero, 20n * E18]);
  });

  it("passes sorted-list hints through, checksummed", () => {
    const t = tx.addCollateral({ vault, amount: 5n, hints: [ADDR.alice.toLowerCase(), ADDR.bob] });
    expect(t.value).toBe(5n);
    expect(decode(t, vaultAbi).args).toEqual([ADDR.alice, ADDR.bob]);
  });

  it("encodes borrow, withdraw, repay and refinance arguments in contract order", () => {
    expect(decode(tx.borrow({ vault, amount: 3n, maxFee: 4n }), vaultAbi).args).toEqual([3n, zero, zero, 4n]);
    expect(decode(tx.withdrawCollateral({ vault, amount: 3n }), vaultAbi).args).toEqual([3n, zero, zero]);
    expect(decode(tx.repay({ vault, amount: 3n }), vaultAbi).args).toEqual([3n, zero, zero]);
    expect(decode(tx.refinance({ vault, maxFee: 9n, minRateDropBps: 25 }), vaultAbi).args).toEqual([zero, zero, 9n, 25]);
  });

  it("sets a policy with epoch zero and inactive, which the vault fills in", () => {
    const d = decode(tx.setPolicy({ vault, policy }), vaultAbi);
    expect(d.functionName).toBe("setPolicy");
    expect((d.args as unknown[])[0]).toEqual({ epoch: 0n, ...policy, active: false });
  });

  it("builds execute at the sorted floor and at the cap for a defense policy", () => {
    expect(tx.execute({ vault }).gas).toBe(6_785_885n);
    expect(tx.execute({ vault, gas: { defenseWalk: true } }).gas).toBe(9_500_000n);
  });

  it("approves the market for one position and MUSD for a spender", () => {
    const a = tx.approveMarketFor({ tokenId: 7n });
    expect(a.to).toBe(matsnet.trozu.nft);
    expect(decode(a, nftAbi).args).toEqual([matsnet.trozu.market, 7n]);
    const m = tx.approveMusd({ spender: vault, amount: 5n });
    expect(m.to).toBe(matsnet.mezo.musd);
  });

  it("builds a buy with the bounds and no permit unless given", () => {
    const bounds = { expectedEpoch: 1n, minColl: 2n, maxDebt: 3n, minRateBps: 100, maxRateBps: 100, maxPrice: 4n, minReserveBtc: 5n, minReserveMusd: 6n };
    const t = tx.buy({ listing: sampleListing(), signature: "0x" + "cd".repeat(65) as `0x${string}`, bounds, recipient: ADDR.bob });
    expect(t.to).toBe(matsnet.trozu.market);
    const d = decode(t, marketAbi);
    expect(d.functionName).toBe("buy");
    const args = d.args as unknown[];
    expect(args[2]).toEqual(bounds);
    expect(args[3]).toBe(ADDR.bob);
    expect(args[4]).toEqual({ deadline: 0n, v: 0, r: zeroHash, s: zeroHash });
  });

  it("writes the summary from the arguments", () => {
    expect(tx.addCollateral({ vault, amount: E18 }).summary).toBe("Add 1 BTC of collateral to the position at 0x3333…3333.");
  });
});

describe("validation", () => {
  const issues = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(TrozuValidationError);
      return (e as TrozuValidationError).issues.join("|");
    }
    throw new Error("did not throw");
  };

  it("rejects bad addresses, zero amounts and out of range numbers before encoding anything", () => {
    expect(issues(() => tx.addCollateral({ vault: "0x1234", amount: 1n }))).toMatch(/vault is not a valid address/);
    expect(issues(() => tx.addCollateral({ vault, amount: 0n }))).toMatch(/amount has to be above zero/);
    expect(issues(() => tx.addCollateral({ vault, amount: -1n }))).toMatch(/amount/);
    expect(issues(() => tx.addCollateral({ vault, amount: 2n ** 256n }))).toMatch(/amount/);
    expect(issues(() => tx.addCollateral({ vault, amount: "1.5" }))).toMatch(/amount/);
    expect(issues(() => tx.refinance({ vault, maxFee: 1n, minRateDropBps: 70_000 }))).toMatch(/minRateDropBps/);
    expect(issues(() => tx.openPosition({ debt: 0n, collateral: 0n, maxFee: 0n }))).toMatch(/debt.*\|collateral/);
  });

  it("accepts decimal strings for amounts, since JSON cannot carry a bigint", () => {
    expect(tx.repay({ vault, amount: "1000000000000000000" }).data).toBe(tx.repay({ vault, amount: E18 }).data);
  });

  it("refuses a policy the vault would refuse, and says why", () => {
    expect(issues(() => tx.setPolicy({ vault, policy: { ...policy, floorIcr: 11n * 10n ** 17n } }))).toMatch(/floorIcr/);
    expect(issues(() => tx.setPolicy({ vault, policy: { ...policy, period: -1 } }))).toMatch(/period/);
  });

  it("refuses to send a position or a purchase to the zero address", () => {
    expect(issues(() => tx.transferPosition({ from: ADDR.alice, to: zero, tokenId: 1n }))).toMatch(/zero address/);
    const bounds = { expectedEpoch: 0n, minColl: 0n, maxDebt: 0n, minRateBps: 0, maxRateBps: 0, maxPrice: 0n, minReserveBtc: 0n, minReserveMusd: 0n };
    expect(issues(() => tx.buy({ listing: sampleListing(), signature: "0x" + "cd".repeat(65) as `0x${string}`, bounds, recipient: zero }))).toMatch(/zero address/);
  });

  it("refuses a signature that is not hex, or too long", () => {
    expect(issues(() => tx.announce({ listing: sampleListing(), signature: "0xzz" as `0x${string}` }))).toMatch(/signature/);
    expect(issues(() => tx.announce({ listing: sampleListing(), signature: ("0x" + "ab".repeat(3000)) as `0x${string}` }))).toMatch(/signature/);
  });
});
