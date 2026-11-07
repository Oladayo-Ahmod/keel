import { guarded, toUint, vaultOf, type Context } from "./context.js";
import { vaultAbi } from "./generated/abis.js";
import { NO_DEBT_ICR, remaining, windowFresh } from "./math.js";
import type { GuardianStatus, PlanView, PolicyKind, PolicyReason, PolicyView } from "./types.js";

const KINDS: PolicyKind[] = ["None", "TopUpBtc", "RepayMusd", "DefendBtc"];
const REASONS: PolicyReason[] = ["None", "NoPolicy", "PolicyStale", "TroveInactive", "NoPrice", "Healthy", "BufferUnknown", "NoReserve", "BelowMinimum"];

export const kindName = (i: number | bigint): PolicyKind => KINDS[Number(i)] ?? "None";
export const reasonName = (i: number | bigint): PolicyReason => REASONS[Number(i)] ?? "None";

/** Reasons where `plan.icr` is not a real reading, so a margin to the floor would mean nothing. */
const NO_READING: PolicyReason[] = ["NoPolicy", "PolicyStale", "TroveInactive", "NoPrice"];

export function guardianReads(ctx: Context) {
  const { client } = ctx;

  /** The policy, the plan `execute` would follow right now, the reserve and what is left of this period's allowance. */
  async function status(tokenId: bigint | number | string): Promise<GuardianStatus> {
    const id = toUint("tokenId", tokenId);
    const vault = await vaultOf(ctx, id);
    const read = <T>(f: () => Promise<T>) => guarded(f);

    const [p, live, pv, reserveBtc, reserveMusd, spentBtc, spentMusd, periodStart, block] = await Promise.all([
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "policy" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "policyLive" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "preview" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "reserveBtc" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "reserveMusd" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "spentBtc" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "spentMusd" })),
      read(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "periodStart" })),
      read(() => client.getBlock({ blockTag: "latest" })),
    ]);

    const policy: PolicyView = {
      epoch: p.epoch,
      floorIcr: p.floorIcr,
      targetIcr: p.targetIcr,
      maxActionBtc: p.maxActionBtc,
      maxActionMusd: p.maxActionMusd,
      periodCapBtc: p.periodCapBtc,
      periodCapMusd: p.periodCapMusd,
      keeperTipBtc: p.keeperTipBtc,
      bufferFloorMusd: p.bufferFloorMusd,
      period: p.period,
      maxWalkSteps: p.maxWalkSteps,
      active: p.active,
    };
    const plan: PlanView = { kind: kindName(pv.kind), reason: reasonName(pv.reason), amount: pv.amount, tip: pv.tip, icr: pv.icr, resetWindow: pv.resetWindow };

    // spent amounts only count inside the window they were spent in
    const rolled = windowFresh(BigInt(periodStart), policy.period, block.timestamp);
    const spent = rolled ? { btc: 0n, musd: 0n } : { btc: spentBtc, musd: spentMusd };
    const hasReading = live && !NO_READING.includes(plan.reason) && plan.icr > 0n && plan.icr < NO_DEBT_ICR;

    return {
      tokenId: id,
      vault,
      policy,
      live,
      plan,
      reserve: { btc: reserveBtc, musd: reserveMusd },
      spent,
      allowance: { btc: remaining(policy.periodCapBtc, spent.btc), musd: remaining(policy.periodCapMusd, spent.musd) },
      periodStart: BigInt(periodStart),
      windowResets: BigInt(periodStart) + BigInt(policy.period),
      marginToFloor: hasReading ? plan.icr - policy.floorIcr : null,
    };
  }

  return { status };
}

export type GuardianReads = ReturnType<typeof guardianReads>;
