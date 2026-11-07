import { createTrozu, nftAbi, vaultAbi, lensAbi, type Hex } from "@trozu/sdk";
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { ADDR, mockChain, type MockLog } from "../../sdk/test/mockChain.js";

export { ADDR } from "../../sdk/test/mockChain.js";
export const E18 = 10n ** 18n;

export interface Opts {
  /** ratio the vault's preview reports, 1e18. Default 145%. */
  icr?: bigint;
  /** preview kind and reason indexes. Default None / Healthy. */
  kind?: number;
  reason?: number;
  live?: boolean;
  floorPercent?: bigint;
  reserveBtc?: bigint;
}

/** The real SDK over a mock chain with one guarded position, token 7, whose vault is ADDR.vault. */
export function chain(o: Opts = {}) {
  const m = mockChain();
  m.contract(m.deployment.trozu.nft, nftAbi as never, { vaultOf: () => ADDR.vault, transferEpoch: () => 1n });
  m.contract(m.deployment.trozu.lens, lensAbi as never, { positionsOf: () => [7n] });
  m.contract(ADDR.vault, vaultAbi as never, {
    policy: () => ({
      epoch: 1n, floorIcr: (o.floorPercent ?? 130n) * 10n ** 16n, targetIcr: 160n * 10n ** 16n, maxActionBtc: E18 / 10n, maxActionMusd: 0n, periodCapBtc: E18 / 2n,
      periodCapMusd: 0n, keeperTipBtc: 5n * 10n ** 13n, bufferFloorMusd: 0n, period: 86_400, maxWalkSteps: 0, active: true,
    }),
    policyLive: () => o.live ?? true,
    preview: () => ({ kind: o.kind ?? 0, reason: o.reason ?? 5, amount: 0n, tip: 0n, icr: o.icr ?? 145n * 10n ** 16n, resetWindow: false }),
    reserveBtc: () => o.reserveBtc ?? 3n * E18,
    reserveMusd: () => 0n,
    spentBtc: () => 0n,
    spentMusd: () => 0n,
    periodStart: () => 0n,
  });
  const trozu = createTrozu({ client: m.client, deployment: m.deployment });
  const action = (kind: number, amount: bigint, tip: bigint, icrBefore: bigint, block: bigint) => m.state.logs.push(actionLog(kind, amount, tip, icrBefore, block));
  return { m, trozu, client: m.client, action };
}

/** A GuardianAction log as the vault would emit it. */
export function actionLog(kind: number, amount: bigint, tip: bigint, icrBefore: bigint, block: bigint): MockLog {
  const event = getAbiItem({ abi: vaultAbi, name: "GuardianAction" });
  const topics = encodeEventTopics({ abi: [event], eventName: "GuardianAction" } as never) as Hex[];
  const data = encodeAbiParameters(event.inputs as never, [ADDR.bob, kind, amount, tip, icrBefore] as never);
  return { address: ADDR.vault, blockNumber: block, topics, data, txHash: ("0x" + block.toString(16).padStart(64, "0")) as Hex };
}
