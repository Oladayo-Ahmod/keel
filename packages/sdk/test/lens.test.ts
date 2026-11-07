import { describe, expect, it } from "vitest";
import { createTrozu } from "../src/client.js";
import { TrozuNotFoundError, TrozuValidationError } from "../src/errors.js";
import { lensAbi } from "../src/generated/abis.js";
import { ADDR, mockChain } from "./mockChain.js";

const E18 = 10n ** 18n;
const NO_DEBT = 2n ** 256n - 1n;

function info(over: Record<string, unknown> = {}) {
  return {
    tokenId: 7n,
    vault: ADDR.vault,
    holder: ADDR.alice,
    active: true,
    coll: 2n * E18,
    principal: 1_000n * E18,
    interest: 5n * E18,
    debt: 1_005n * E18,
    priceOk: true,
    price: 100_000n * E18,
    icr: (1990n * E18) / 1000n,
    equity: 199_000n * E18 - 1_005n * E18,
    lockedRateBps: 450,
    globalRateBps: 300,
    spreadBps: 150n,
    annualSpreadMusd: 15n * E18,
    claimableSurplus: 0n,
    refinanceFeeEstimate: 3n * E18,
    redeemable: true,
    recoveryMode: false,
    canClose: true,
    ...over,
  };
}

function setup(impl: Record<string, (a: readonly unknown[]) => unknown>) {
  const m = mockChain();
  m.contract(m.deployment.trozu.lens, lensAbi as never, impl);
  return { m, trozu: createTrozu({ client: m.client, deployment: m.deployment }) };
}

describe("lens reads", () => {
  it("reads a position: ratio, equity, locked against market rate, and a risk label", async () => {
    const { trozu } = setup({ positionInfo: () => info() });
    const p = await trozu.lens.position(7n);
    expect(p.holder).toBe(ADDR.alice);
    expect(p.icr).toBe((1990n * E18) / 1000n);
    expect(p.lockedRateBps).toBe(450);
    expect(p.marketRateBps).toBe(300);
    expect(p.spreadBps).toBe(150n);
    expect(p.equity).toBe(197_995n * E18); // 199,000 of collateral less 1,005 of debt
    expect(p.risk).toBe("safe");
    expect(p.hasDebt).toBe(true);
  });

  it("reports a thin position as at risk and a drained one as liquidatable", async () => {
    const thin = setup({ positionInfo: () => info({ icr: 115n * 10n ** 16n }) });
    expect((await thin.trozu.lens.position(7)).risk).toBe("danger");
    const low = setup({ positionInfo: () => info({ icr: 105n * 10n ** 16n, equity: -5n * E18 }) });
    const p = await low.trozu.lens.position("7");
    expect(p.risk).toBe("liquidatable");
    expect(p.equity).toBe(-5n * E18);
  });

  it("knows a trove with no debt, and a closed position", async () => {
    const nodebt = setup({ positionInfo: () => info({ icr: NO_DEBT, debt: 0n, principal: 0n, interest: 0n }) });
    const p = await nodebt.trozu.lens.position(7n);
    expect(p.hasDebt).toBe(false);
    expect(p.risk).toBe("safe");
    const closed = setup({ positionInfo: () => info({ active: false, coll: 0n, debt: 0n, icr: 0n }) });
    expect((await closed.trozu.lens.position(7n)).risk).toBe("none");
  });

  it("says not found for a position that was never minted", async () => {
    const { trozu } = setup({ positionInfo: () => info({ vault: "0x0000000000000000000000000000000000000000" }) });
    await expect(trozu.lens.position(99n)).rejects.toBeInstanceOf(TrozuNotFoundError);
  });

  it("rejects a token id that is not a whole number before calling the node", async () => {
    const { m, trozu } = setup({ positionInfo: () => info() });
    await expect(trozu.lens.position("seven")).rejects.toBeInstanceOf(TrozuValidationError);
    await expect(trozu.lens.position(-1)).rejects.toBeInstanceOf(TrozuValidationError);
    expect(m.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);
  });

  it("lists the positions a wallet holds, after validating the address", async () => {
    const { trozu } = setup({ positionsOf: () => [3n, 9n] });
    expect(await trozu.lens.positionsOf(ADDR.alice)).toEqual([3n, 9n]);
    await expect(trozu.lens.positionsOf("nope")).rejects.toBeInstanceOf(TrozuValidationError);
  });

  it("reads the redemption buffer and the verdict against a threshold", async () => {
    const buf = { buffer: 40_000n * E18, eligibleAhead: 12n, steps: 12n, complete: true, inList: true };
    const { trozu } = setup({ redemptionBuffer: () => buf, bufferAtLeast: (a) => [(a[1] as bigint) > 50_000n * E18 ? 2 : 1, buf] });
    expect((await trozu.lens.redemptionBuffer(7n)).buffer).toBe(40_000n * E18);
    const above = await trozu.lens.bufferCheck(7n, 30_000n * E18);
    expect(above.verdict).toBe("above");
    const below = await trozu.lens.bufferCheck(7n, 60_000n * E18);
    expect(below.verdict).toBe("below");
    expect(below.threshold).toBe(60_000n * E18);
  });

  it("passes an unknown verdict through as unknown, never as safe", async () => {
    const buf = { buffer: 1n, eligibleAhead: 100n, steps: 100n, complete: false, inList: true };
    const { trozu } = setup({ bufferAtLeast: () => [0, buf] });
    const c = await trozu.lens.bufferCheck(7n, 10n);
    expect(c.verdict).toBe("unknown");
    expect(c.complete).toBe(false);
  });

  it("limits the walk to 100 troves", async () => {
    const { trozu } = setup({});
    await expect(trozu.lens.redemptionBuffer(7n, 101)).rejects.toBeInstanceOf(TrozuValidationError);
    await expect(trozu.lens.bufferCheck(7n, 1n, -1)).rejects.toBeInstanceOf(TrozuValidationError);
  });
});
