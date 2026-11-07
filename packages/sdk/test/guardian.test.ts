import { describe, expect, it } from "vitest";
import { createTrozu } from "../src/client.js";
import { TrozuNotFoundError } from "../src/errors.js";
import { nftAbi, vaultAbi } from "../src/generated/abis.js";
import { ADDR, mockChain } from "./mockChain.js";

const E18 = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";

const policy = {
  epoch: 1n,
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
  active: true,
};

function setup(o: { policy?: Partial<typeof policy>; live?: boolean; preview?: Record<string, unknown>; periodStart?: bigint; spentBtc?: bigint; vault?: string } = {}) {
  const m = mockChain();
  m.contract(m.deployment.trozu.nft, nftAbi as never, { vaultOf: () => o.vault ?? ADDR.vault });
  m.contract(ADDR.vault, vaultAbi as never, {
    policy: () => ({ ...policy, ...o.policy }),
    policyLive: () => o.live ?? true,
    preview: () => ({ kind: 0, reason: 5, amount: 0n, tip: 0n, icr: 145n * 10n ** 16n, resetWindow: false, ...o.preview }),
    reserveBtc: () => 3n * E18,
    reserveMusd: () => 0n,
    spentBtc: () => o.spentBtc ?? E18 / 5n,
    spentMusd: () => 0n,
    periodStart: () => o.periodStart ?? m.state.timestamp - 3_600n,
  });
  return { m, trozu: createTrozu({ client: m.client, deployment: m.deployment }) };
}

describe("guardian status", () => {
  it("reads the policy, the plan, the reserve and the margin to the floor", async () => {
    const { trozu } = setup();
    const s = await trozu.guardian.status(7n);
    expect(s.vault).toBe(ADDR.vault);
    expect(s.live).toBe(true);
    expect(s.policy.floorIcr).toBe(13n * 10n ** 17n);
    expect(s.policy.period).toBe(86_400);
    expect(s.plan.kind).toBe("None");
    expect(s.plan.reason).toBe("Healthy");
    expect(s.reserve).toEqual({ btc: 3n * E18, musd: 0n });
    // 145% against a 130% floor
    expect(s.marginToFloor).toBe(15n * 10n ** 16n);
  });

  it("subtracts what was spent this period from the cap", async () => {
    const { trozu } = setup();
    const s = await trozu.guardian.status(7n);
    expect(s.spent.btc).toBe(E18 / 5n);
    expect(s.allowance.btc).toBe((E18 * 3n) / 10n);
  });

  it("counts spending as zero once the window has rolled over", async () => {
    const { m, trozu } = setup({ periodStart: 1_000n });
    const s = await trozu.guardian.status(7n);
    expect(m.state.timestamp).toBeGreaterThan(s.windowResets);
    expect(s.spent).toEqual({ btc: 0n, musd: 0n });
    expect(s.allowance.btc).toBe(E18 / 2n);
  });

  it("goes negative under the floor and names what the keeper would do", async () => {
    const { trozu } = setup({ preview: { kind: 1, reason: 0, amount: E18 / 20n, tip: 5n * 10n ** 13n, icr: 125n * 10n ** 16n } });
    const s = await trozu.guardian.status(7n);
    expect(s.marginToFloor).toBe(-5n * 10n ** 16n);
    expect(s.plan).toMatchObject({ kind: "TopUpBtc", reason: "None", amount: E18 / 20n });
  });

  it("gives no margin when there is no live policy, however the preview reads", async () => {
    const { trozu } = setup({ live: false, preview: { reason: 1, icr: 0n } });
    const s = await trozu.guardian.status(7n);
    expect(s.live).toBe(false);
    expect(s.plan.reason).toBe("NoPolicy");
    expect(s.marginToFloor).toBeNull();
  });

  it("gives no margin for a trove with no debt, or when the price feed is down", async () => {
    expect((await setup({ preview: { icr: 2n ** 256n - 1n } }).trozu.guardian.status(7n)).marginToFloor).toBeNull();
    expect((await setup({ preview: { reason: 4, icr: 0n } }).trozu.guardian.status(7n)).marginToFloor).toBeNull();
  });

  it("treats an out-of-range kind or reason as none instead of throwing", async () => {
    const { trozu } = setup({ preview: { kind: 9, reason: 77 } });
    const s = await trozu.guardian.status(7n);
    expect(s.plan.kind).toBe("None");
    expect(s.plan.reason).toBe("None");
  });

  it("says not found for a token with no vault", async () => {
    const { trozu } = setup({ vault: ZERO });
    await expect(trozu.guardian.status(1n)).rejects.toBeInstanceOf(TrozuNotFoundError);
  });
});
