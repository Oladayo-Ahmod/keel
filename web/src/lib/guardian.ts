import { formatBtc, formatIcr, formatMusd } from "./format";

const WAD = 10n ** 18n;

/** Limits baked into TrozuVault. The page reads them from the contract; these are the fallbacks the tests use. */
export interface Limits {
  mcr: bigint; // 1.1e18, a constant in the vault
  maxTargetIcr: bigint;
  minPeriod: number;
  maxPeriod: number;
  maxKeeperTip: bigint;
  maxWalkSteps: number;
}

export const LIMITS: Limits = {
  mcr: 11n * 10n ** 17n,
  maxTargetIcr: 5n * WAD,
  minPeriod: 3600,
  maxPeriod: 30 * 86400,
  maxKeeperTip: 10n ** 14n,
  maxWalkSteps: 100,
};

/** Mirrors the `Policy` struct passed to `setPolicy`. `epoch` and `active` are set by the vault and ignored. */
export interface PolicyInput {
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
}

/**
 * The reasons `setPolicy` would revert with `BadPolicy`, in the same order as the contract checks them,
 * so a holder reads a sentence instead of paying for a failed transaction.
 */
export function validatePolicy(p: PolicyInput, l: Limits = LIMITS): string[] {
  const e: string[] = [];
  if (p.floorIcr <= l.mcr) e.push("The floor has to be above 110%, the line where Mezo liquidates.");
  if (p.targetIcr <= p.floorIcr) e.push("The target has to be above the floor.");
  if (p.targetIcr > l.maxTargetIcr) e.push("The target cannot be above 500%.");
  if (p.period < l.minPeriod || p.period > l.maxPeriod) e.push("The period has to be between 1 hour and 30 days.");
  if (p.keeperTipBtc > l.maxKeeperTip) e.push(`The keeper tip cannot be more than ${formatBtc(l.maxKeeperTip)} BTC.`);
  if (p.maxActionBtc === 0n && p.maxActionMusd === 0n) e.push("Allow at least one kind of action: BTC top-ups or MUSD repayments.");
  if (p.maxActionBtc > p.periodCapBtc || p.maxActionMusd > p.periodCapMusd) e.push("A single action cannot be larger than the period cap.");
  if (p.keeperTipBtc > 0n && p.keeperTipBtc >= p.periodCapBtc) e.push("The tip has to be below the BTC period cap, because it counts against it.");
  if (p.maxWalkSteps > l.maxWalkSteps) e.push("The queue check cannot walk more than 100 troves.");
  if (p.bufferFloorMusd > 0n && (p.maxWalkSteps === 0 || p.maxActionBtc === 0n)) {
    e.push("Redemption defense needs a queue check length above zero and a BTC action limit.");
  }
  return e;
}

/** Soft warnings: legal policies that are probably not what the holder wants. */
export function policyWarnings(p: PolicyInput): string[] {
  const w: string[] = [];
  if (p.floorIcr > 0n && p.floorIcr < 13n * 10n ** 17n) {
    w.push("A floor under 130% leaves little room. Mezo refuses any top-up that would still leave the trove under 110%, so the guardian cannot rescue a position that is already too low.");
  }
  if (p.keeperTipBtc === 0n) w.push("With no tip, nobody has a reason to call the guardian for you. You would have to call it yourself.");
  if (p.bufferFloorMusd > 0n && p.targetIcr <= p.floorIcr + WAD / 10n) {
    w.push("Redemption defense raises the ratio only up to the target. A target close to the floor leaves it little to do.");
  }
  return w;
}

export type Kind = "None" | "TopUpBtc" | "RepayMusd" | "DefendBtc";
export type Reason = "None" | "NoPolicy" | "PolicyStale" | "TroveInactive" | "NoPrice" | "Healthy" | "BufferUnknown" | "NoReserve" | "BelowMinimum";

const KINDS: Kind[] = ["None", "TopUpBtc", "RepayMusd", "DefendBtc"];
const REASONS: Reason[] = ["None", "NoPolicy", "PolicyStale", "TroveInactive", "NoPrice", "Healthy", "BufferUnknown", "NoReserve", "BelowMinimum"];

export const kindName = (i: number | bigint): Kind => KINDS[Number(i)] ?? "None";
export const reasonName = (i: number | bigint): Reason => REASONS[Number(i)] ?? "None";

export interface PlanView {
  kind: Kind;
  reason: Reason;
  amount: bigint;
  tip: bigint;
  icr: bigint;
}

const REASON_TEXT: Record<Reason, string> = {
  None: "Nothing to report.",
  NoPolicy: "No policy is set, so the guardian will not act.",
  PolicyStale: "The policy was set by a previous holder, so it is switched off. Set a new one.",
  TroveInactive: "The position has no open trove, so there is nothing to protect.",
  NoPrice: "The price feed is not answering, so the guardian waits.",
  Healthy: "The ratio is at or above the floor. Nothing to do.",
  BufferUnknown: "The queue check could not prove the redemption buffer is low, so the guardian waits.",
  NoReserve: "The reserve or this period's allowance is used up, so the guardian cannot act.",
  BelowMinimum: "Every action the policy allows would still leave the position too low for Mezo to accept. It waits.",
};

/** One sentence on what a call to `execute` would do right now. */
export function describePlan(p: PlanView): string {
  switch (p.kind) {
    case "TopUpBtc":
      return `Would add ${formatBtc(p.amount)} BTC from the reserve to lift the ratio from ${formatIcr(p.icr)}.${p.tip > 0n ? ` The caller earns ${formatBtc(p.tip)} BTC.` : ""}`;
    case "RepayMusd":
      return `Would repay ${formatMusd(p.amount)} MUSD from the reserve to lift the ratio from ${formatIcr(p.icr)}.${p.tip > 0n ? ` The caller earns ${formatBtc(p.tip)} BTC.` : ""}`;
    case "DefendBtc":
      return `Would add ${formatBtc(p.amount)} BTC from the reserve because the redemption buffer is below your floor.${p.tip > 0n ? ` The caller earns ${formatBtc(p.tip)} BTC.` : ""}`;
    case "None":
      return REASON_TEXT[p.reason];
  }
}

export const KIND_LABEL: Record<Kind, string> = {
  None: "none",
  TopUpBtc: "Added BTC",
  RepayMusd: "Repaid MUSD",
  DefendBtc: "Added BTC (redemption defense)",
};

/** Whether a stored policy is currently in force, given the NFT's epoch. */
export function policyLive(policy: { active: boolean; epoch: bigint }, currentEpoch: bigint): boolean {
  return policy.active && policy.epoch === currentEpoch;
}

/** How much of a period's allowance is left, never negative. */
export function remaining(cap: bigint, spent: bigint): bigint {
  return cap > spent ? cap - spent : 0n;
}

/** Whether the spending window has rolled over, so spent amounts no longer count. */
export function windowFresh(periodStart: bigint, period: number, now: bigint): boolean {
  return now >= periodStart + BigInt(period);
}
