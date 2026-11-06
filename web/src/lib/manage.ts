import { APP_MIN_ICR, GAS_RESERVE } from "./open";
import { GAS_COMPENSATION } from "./hints";
import { formatBtc, formatMusd } from "./format";
import { MCR, SAFE } from "./risk";

const WAD = 10n ** 18n;
const NICR_PRECISION = 10n ** 20n;

/** What the plans need to know about a position, taken from the Lens. */
export interface Snapshot {
  active: boolean;
  priceOk: boolean;
  price: bigint;
  coll: bigint;
  principal: bigint;
  interest: bigint;
  recoveryMode: boolean;
  canClose: boolean;
  lockedRateBps: number;
  globalRateBps: number;
  refinanceFeeEstimate: bigint;
  annualSpreadMusd: bigint;
  claimableSurplus: bigint;
}

/** Wallet and chain facts the checks need. Anything unknown is left undefined and blocks the action. */
export interface Wallet {
  btc: bigint | undefined;
  musd: bigint | undefined;
  allowance: bigint | undefined;
  minNetDebt: bigint | undefined;
}

export interface Plan {
  errors: string[];
  warnings: string[];
  newColl: bigint;
  newDebt: bigint;
  /** 1e18 ratio after the change. Undefined when it cannot be computed or there is no debt. */
  newIcr: bigint | undefined;
  /** Where the trove will sit in Mezo's sorted list afterwards, for the hint lookup. */
  hintNicr: bigint | undefined;
}

export const totalDebt = (s: Pick<Snapshot, "principal" | "interest">) => s.principal + s.interest;

export function icrOf(coll: bigint, debt: bigint, price: bigint): bigint | undefined {
  if (debt === 0n || price === 0n) return undefined;
  return (coll * price) / debt;
}

function nicrOf(coll: bigint, principal: bigint): bigint | undefined {
  return principal === 0n ? undefined : (coll * NICR_PRECISION) / principal;
}

function base(s: Snapshot): Plan {
  const debt = totalDebt(s);
  return {
    errors: [],
    warnings: [],
    newColl: s.coll,
    newDebt: debt,
    newIcr: icrOf(s.coll, debt, s.price),
    hintNicr: nicrOf(s.coll, s.principal),
  };
}

/** Checks every plan shares: a trove has to exist and the price has to be known. */
function common(s: Snapshot, p: Plan, needsPrice: boolean) {
  if (!s.active) p.errors.push("This position has no open trove, so there is nothing to change.");
  if (needsPrice && (!s.priceOk || s.price === 0n)) p.errors.push("The price feed did not answer, so the ratio cannot be checked.");
}

function judgeRatio(s: Snapshot, p: Plan) {
  if (p.newIcr === undefined) return;
  if (p.newIcr < MCR) {
    p.errors.push("This would leave the position under 110%, where Mezo liquidates and refuses the change.");
  } else if (p.newIcr < APP_MIN_ICR) {
    p.errors.push("This would leave the ratio under 120%. Trozu refuses anything that close to liquidation.");
  } else if (p.newIcr < SAFE) {
    p.warnings.push("Under 150% a modest price drop gets this position liquidated.");
  }
}

export function planAddCollateral(s: Snapshot, amount: bigint, w: Wallet): Plan {
  const p = base(s);
  common(s, p, false);
  p.newColl = s.coll + amount;
  p.newIcr = icrOf(p.newColl, p.newDebt, s.price);
  p.hintNicr = nicrOf(p.newColl, s.principal);
  if (w.btc === undefined) p.errors.push("Your BTC balance has not loaded yet.");
  else if (amount + GAS_RESERVE > w.btc) p.errors.push(`Not enough BTC: this needs ${formatBtc(amount)} plus about ${formatBtc(GAS_RESERVE)} for gas.`);
  return p;
}

export function planWithdraw(s: Snapshot, amount: bigint): Plan {
  const p = base(s);
  common(s, p, true);
  if (s.recoveryMode) p.errors.push("Mezo is in Recovery Mode, which blocks collateral withdrawals until the system is back above 150%.");
  if (amount > s.coll) {
    p.errors.push("That is more collateral than the position holds.");
    return p;
  }
  p.newColl = s.coll - amount;
  p.newIcr = icrOf(p.newColl, p.newDebt, s.price);
  p.hintNicr = nicrOf(p.newColl, s.principal);
  if (p.newColl === 0n) p.errors.push("Withdrawing everything would empty the trove. Close the position instead.");
  judgeRatio(s, p);
  return p;
}

/** Largest withdrawal that leaves the ratio at or above `targetIcr` (1e18). Zero when none. */
export function maxWithdraw(s: Snapshot, targetIcr: bigint): bigint {
  if (s.price === 0n) return 0n;
  const debt = totalDebt(s);
  const keep = (debt * targetIcr + s.price - 1n) / s.price; // rounded up so the ratio stays at or above the target
  return s.coll > keep ? s.coll - keep : 0n;
}

export function planBorrow(s: Snapshot, amount: bigint, fee: bigint | undefined): Plan {
  const p = base(s);
  common(s, p, true);
  if (fee === undefined) {
    p.errors.push("The borrowing fee has not loaded yet.");
    return p;
  }
  const added = amount + fee;
  p.newDebt = totalDebt(s) + added;
  p.newIcr = icrOf(s.coll, p.newDebt, s.price);
  p.hintNicr = nicrOf(s.coll, s.principal + added);
  if (s.recoveryMode && p.newIcr !== undefined && p.newIcr < SAFE) {
    p.errors.push("In Recovery Mode Mezo only lets a trove borrow if it stays at or above 150%.");
  }
  judgeRatio(s, p);
  return p;
}

/** Biggest repayment Mezo accepts: it must leave net debt at or above the minimum. */
export function maxRepay(s: Snapshot, minNetDebt: bigint | undefined): bigint {
  const netDebt = totalDebt(s) - GAS_COMPENSATION;
  if (minNetDebt === undefined || netDebt <= minNetDebt) return 0n;
  return netDebt - minNetDebt;
}

export function planRepay(s: Snapshot, amount: bigint, w: Wallet): Plan {
  const p = base(s);
  common(s, p, false);
  const debt = totalDebt(s);
  const cap = maxRepay(s, w.minNetDebt);
  if (w.minNetDebt === undefined) p.errors.push("Mezo's minimum debt has not loaded yet.");
  else if (amount > cap) {
    p.errors.push(
      cap === 0n
        ? "This position is at Mezo's minimum debt, so it cannot be partly repaid. Close it instead."
        : `Mezo requires the debt to stay above its minimum, so at most ${formatMusd(cap)} MUSD can be repaid. Close the position to repay everything.`,
    );
  }
  if (w.musd === undefined) p.errors.push("Your MUSD balance has not loaded yet.");
  else if (amount > w.musd) p.errors.push(`You hold ${formatMusd(w.musd)} MUSD, which is less than this repayment.`);
  const reduce = amount > debt ? debt : amount;
  p.newDebt = debt - reduce;
  p.newIcr = icrOf(s.coll, p.newDebt, s.price);
  // interest is paid before principal
  const principalPaid = reduce > s.interest ? reduce - s.interest : 0n;
  p.hintNicr = nicrOf(s.coll, s.principal - (principalPaid > s.principal ? s.principal : principalPaid));
  return p;
}

/** How a repayment will be authorised. A permit needs no extra transaction. */
export type Approval = "allowance" | "permit" | "approve";

export function approvalFor(amount: bigint, allowance: bigint | undefined, permitUsable: boolean): Approval {
  if (allowance !== undefined && allowance >= amount) return "allowance";
  return permitUsable ? "permit" : "approve";
}

export interface RefinancePlan extends Plan {
  dropBps: number;
  fee: bigint;
  /** MUSD saved per year at today's principal, never negative. */
  yearlySaving: bigint;
  /** Days of saving that pay back the fee, undefined when there is no saving. */
  breakEvenDays: number | undefined;
  maxFee: bigint;
}

export function planRefinance(s: Snapshot): RefinancePlan {
  const p = base(s);
  common(s, p, false);
  const drop = s.lockedRateBps - s.globalRateBps;
  const fee = s.refinanceFeeEstimate;
  const saving = s.annualSpreadMusd > 0n ? s.annualSpreadMusd : 0n;
  const out: RefinancePlan = {
    ...p,
    dropBps: drop,
    fee,
    yearlySaving: saving,
    // a little room above the estimate for interest that accrues before the transaction lands
    maxFee: fee + fee / 20n + 1n,
    breakEvenDays: saving > 0n ? Number((fee * 365n * 100n) / saving) / 100 : undefined,
  };
  if (s.recoveryMode) out.errors.push("Mezo is in Recovery Mode, which blocks refinancing until the system is back above 150%.");
  if (drop < 1) {
    out.errors.push(
      drop === 0
        ? "The market rate equals this position's locked rate, so there is nothing to gain."
        : "The market rate is higher than this position's locked rate. Refinancing would raise your rate, so Trozu will not do it.",
    );
  }
  return out;
}

export interface ClosePlan extends Plan {
  cost: bigint;
  returned: bigint;
}

export function planClose(s: Snapshot, w: Wallet): ClosePlan {
  const p = base(s);
  common(s, p, false);
  const cost = totalDebt(s) > GAS_COMPENSATION ? totalDebt(s) - GAS_COMPENSATION : 0n;
  if (s.recoveryMode) p.errors.push("Mezo is in Recovery Mode, which blocks closing until the system is back above 150%.");
  else if (s.active && !s.canClose) p.errors.push("Mezo will not close the last trove in the system. Wait until another trove exists.");
  if (w.musd === undefined) p.errors.push("Your MUSD balance has not loaded yet.");
  else if (cost > w.musd) {
    p.errors.push(`Closing needs ${formatMusd(cost)} MUSD and you hold ${formatMusd(w.musd)}. You are short by ${formatMusd(cost - w.musd)} MUSD.`);
  }
  p.newColl = 0n;
  p.newDebt = 0n;
  p.newIcr = undefined;
  p.hintNicr = undefined;
  return { ...p, cost, returned: s.coll };
}

export function planClaim(s: Snapshot): Plan {
  const p = base(s);
  if (s.claimableSurplus === 0n) p.errors.push("There is no surplus collateral to claim.");
  return p;
}

/** Idle funds in the vault, found outside a normal flow. */
export function planSweep(btc: bigint, musd: bigint): { sweepable: boolean; errors: string[] } {
  const sweepable = btc > 0n || musd > 0n;
  return { sweepable, errors: sweepable ? [] : ["The vault holds nothing outside the trove."] };
}

/** The allowance to request for a close: the cost now plus room for interest until it is mined. */
export function closeAllowance(cost: bigint): bigint {
  return cost + cost / 1000n + 1n; // 0.1%, far more than a few blocks of interest
}

export const WAD_UNIT = WAD;
