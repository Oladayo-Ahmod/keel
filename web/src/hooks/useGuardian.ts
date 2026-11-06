"use client";

import { useQuery } from "@tanstack/react-query";
import type { PublicClient } from "viem";
import { positionNFTAbi } from "@/abi/keel";
import { trozuVaultAbi } from "@/abi/trozu";
import { LOG_WINDOW, wave2 } from "@/config/wave2";
import type { Freshness } from "@/lib/freshness";
import { LIMITS, kindName, reasonName, type Limits, type PlanView } from "@/lib/guardian";
import { freshRead } from "@/lib/rpc";

export interface PolicyOnChain {
  epoch: bigint;
  floorIcr: bigint;
  targetIcr: bigint;
  maxActionBtc: bigint;
  maxActionMusd: bigint;
  periodCapBtc: bigint;
  periodCapMusd: bigint;
  keeperTipBtc: bigint;
  bufferFloorMusd: bigint;
  period: number;
  maxWalkSteps: number;
  active: boolean;
}

export interface GuardianState {
  policy: PolicyOnChain;
  live: boolean;
  plan: PlanView | undefined;
  reserveBtc: bigint;
  reserveMusd: bigint;
  spentBtc: bigint;
  spentMusd: bigint;
  periodStart: bigint;
  epoch: bigint;
  limits: Limits;
}

/** The vault's policy, reserve, spending window and what `preview` says it would do right now. */
export function useGuardian(vault: `0x${string}`, tokenId: bigint) {
  return useQuery({
    queryKey: ["guardian", vault],
    enabled: wave2.enabled,
    refetchInterval: 20_000,
    retry: 1,
    queryFn: async (): Promise<{ data: GuardianState; freshness: Freshness }> =>
      freshRead(async (c) => {
        const r = <F extends string>(functionName: F, args?: readonly unknown[]) =>
          c.readContract({ address: vault, abi: trozuVaultAbi, functionName, args } as never) as Promise<never>;
        const [policy, live, reserveBtc, reserveMusd, spentBtc, spentMusd, periodStart, tip, steps, tgt, minP, maxP, epoch] = await Promise.all([
          r("policy") as Promise<PolicyOnChain>,
          r("policyLive") as Promise<boolean>,
          r("reserveBtc") as Promise<bigint>,
          r("reserveMusd") as Promise<bigint>,
          r("spentBtc") as Promise<bigint>,
          r("spentMusd") as Promise<bigint>,
          r("periodStart") as Promise<bigint>,
          r("MAX_KEEPER_TIP") as Promise<bigint>,
          r("MAX_WALK_STEPS") as Promise<bigint>,
          r("MAX_TARGET_ICR") as Promise<bigint>,
          r("MIN_PERIOD") as Promise<bigint>,
          r("MAX_PERIOD") as Promise<bigint>,
          c.readContract({ address: wave2.nft, abi: positionNFTAbi, functionName: "transferEpoch", args: [tokenId] }),
        ]);
        // preview runs the same code as execute and can fail on a dead price feed, which is not an error here
        const plan = await (r("preview") as Promise<{ kind: number; reason: number; amount: bigint; tip: bigint; icr: bigint }>)
          .then((x) => ({ kind: kindName(x.kind), reason: reasonName(x.reason), amount: x.amount, tip: x.tip, icr: x.icr }) as PlanView)
          .catch(() => undefined);
        const limits: Limits = { ...LIMITS, maxKeeperTip: tip, maxWalkSteps: Number(steps), maxTargetIcr: tgt, minPeriod: Number(minP), maxPeriod: Number(maxP) };
        return { policy, live, plan, reserveBtc, reserveMusd, spentBtc, spentMusd, periodStart, epoch, limits };
      }),
  });
}

export interface KeeperRow {
  block: bigint;
  time: number | undefined;
  keeper: `0x${string}`;
  kind: number;
  amount: bigint;
  tip: bigint;
  icrBefore: bigint;
  tx: `0x${string}`;
}

const actionEvent = trozuVaultAbi.find((x) => x.type === "event" && x.name === "GuardianAction")!;

async function scanHistory(c: PublicClient, vault: `0x${string}`): Promise<KeeperRow[]> {
  const head = await c.getBlockNumber();
  const out: KeeperRow[] = [];
  for (let from = wave2.deployBlock; from <= head; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n > head ? head : from + LOG_WINDOW - 1n;
    const logs = await c.getLogs({ address: vault, event: actionEvent as never, fromBlock: from, toBlock: to });
    for (const log of logs) {
      const l = log as unknown as { blockNumber: bigint; transactionHash: `0x${string}`; args: { keeper: `0x${string}`; kind: number; amount: bigint; tip: bigint; icrBefore: bigint } };
      out.push({ block: l.blockNumber, time: undefined, keeper: l.args.keeper, kind: Number(l.args.kind), amount: l.args.amount, tip: l.args.tip, icrBefore: l.args.icrBefore, tx: l.transactionHash });
    }
  }
  const blocks = [...new Set(out.map((x) => x.block))];
  const stamps = new Map<bigint, number>();
  await Promise.all(blocks.map(async (b) => stamps.set(b, Number((await c.getBlock({ blockNumber: b })).timestamp))));
  return out.map((x) => ({ ...x, time: stamps.get(x.block) })).reverse();
}

/** What keepers have done to this vault. Read on demand, since it walks the vault's log. */
export function useKeeperHistory(vault: `0x${string}`, enabled: boolean) {
  return useQuery({
    queryKey: ["keeper-history", vault],
    enabled: enabled && wave2.enabled,
    retry: 1,
    queryFn: async () => (await freshRead((c) => scanHistory(c, vault))).data,
  });
}
