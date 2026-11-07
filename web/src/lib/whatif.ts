import { LIMITS, type PlanView, type Reason } from "./guardian";

const WAD = 10n ** 18n;
const GAS_COMPENSATION = 200n * WAD;
/** TrozuVault.MIN_ACTION_PER_TIP: an action must move ten times its tip in BTC value, or it pays none. */
const MIN_ACTION_PER_TIP = 10n;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface GuardianSetup {
  /** "none": no policy. "stale": set by a previous holder. "live": in force. */
  state: "none" | "stale" | "live";
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
  reserveBtc: bigint;
  reserveMusd: bigint;
  spentBtc: bigint;
  spentMusd: bigint;
  periodStart: bigint;
}

export interface BufferReading {
  inList: boolean;
  /** MUSD ahead of this trove in the redemption queue. */
  value: bigint;
  /** False means `value` is only a lower bound, because the walk stopped early. */
  complete: boolean;
  steps: number;
}

export interface PlannerState {
  active: boolean;
  coll: bigint;
  debt: bigint;
  price: bigint;
  guardian: GuardianSetup | undefined;
  now: bigint;
  /** What Mezo requires a trove's net debt to stay above. */
  minNetDebt: bigint;
  buffer: BufferReading | undefined;
  /** The model uses 110% as the ratio an action must reach. In Recovery Mode the contract may ask for more. */
  recoveryMode: boolean;
}

/**
 * A port of `TrozuVault._plan`, branch for branch, over numbers handed in instead of read from the chain. The keeper
 * never re-derives a plan: it asks the vault's `preview` and sends `execute` when the kind is not None. This is that
 * decision, run on a state that does not exist yet. Where the contract walks the queue on chain, this takes the
 * walk's result from `buffer`.
 */
export function planGuardian(s: PlannerState, bufferAfter: BufferReading | undefined = s.buffer): PlanView {
  const none = (reason: Reason, icr = 0n): PlanView => ({ kind: "None", reason, amount: 0n, tip: 0n, icr });
  const g = s.guardian;
  if (!g || g.state === "none") return none("NoPolicy");
  if (g.state === "stale") return none("PolicyStale");
  if (!s.active) return none("TroveInactive");
  if (s.debt === 0n) return none("Healthy");

  const icr = (s.coll * s.price) / s.debt;
  const belowFloor = icr < g.floorIcr;
  if (icr >= g.targetIcr || (!belowFloor && g.bufferFloorMusd === 0n)) return none("Healthy", icr);

  if (!belowFloor) {
    // redemption defense: only a complete walk that proves a low buffer may act
    const b = bufferAfter;
    if (!b || !b.inList) return none("BufferUnknown", icr);
    // approximation: the contract also needs the running sum to reach the floor inside maxWalkSteps to say Above
    const complete = b.complete && b.steps <= g.maxWalkSteps;
    if (b.value >= g.bufferFloorMusd) return none("Healthy", icr);
    if (!complete) return none("BufferUnknown", icr);
  }

  const fresh = s.now >= g.periodStart + BigInt(g.period);
  const remBtc = sub(g.periodCapBtc, fresh ? 0n : g.spentBtc);
  const remMusd = sub(g.periodCapMusd, fresh ? 0n : g.spentMusd);
  const tip = g.reserveBtc >= g.keeperTipBtc && remBtc >= g.keeperTipBtc ? g.keeperTipBtc : 0n;
  const tipFor = (valueBtc: bigint) => (valueBtc >= tip * MIN_ACTION_PER_TIP ? tip : 0n);
  const minIcr = LIMITS.mcr;
  let blocked = false;

  // BTC first
  const room = min(min(sub(g.reserveBtc, tip), sub(remBtc, tip)), g.maxActionBtc);
  const need = sub(ceilDiv(g.targetIcr * s.debt, s.price), s.coll);
  const btc = min(room, need);
  if (btc > 0n) {
    if (((s.coll + btc) * s.price) / s.debt >= minIcr) {
      return { kind: belowFloor ? "TopUpBtc" : "DefendBtc", reason: "None", amount: btc, tip: tipFor(btc), icr };
    }
    blocked = true;
  }

  // then a MUSD repay, only for the ratio floor
  if (belowFloor) {
    const minDebt = s.minNetDebt + GAS_COMPENSATION;
    const r1 = min(min(g.reserveMusd, remMusd), g.maxActionMusd);
    const r2 = min(r1, sub(s.debt, minDebt));
    const repay = min(r2, sub(s.debt, (s.coll * s.price) / g.targetIcr));
    if (repay > 0n) {
      if ((s.coll * s.price) / (s.debt - repay) >= minIcr) {
        return { kind: "RepayMusd", reason: "None", amount: repay, tip: tipFor((repay * WAD) / s.price), icr };
      }
      blocked = true;
    }
  }
  return none(blocked ? "BelowMinimum" : "NoReserve", icr);
}

export type BufferVerdict = "unchecked" | "not-queued" | "lower-bound" | "holds" | "below-floor" | "reached";

export interface WhatIfInput extends PlannerState {
  /** Whole percent, -90 to +100. */
  priceChangePct: number;
  /** Percent of the current buffer that redeemers use up. 100 means the queue is exhausted up to this trove. */
  redemptionPct: number;
}

export interface WhatIfResult {
  price: bigint;
  coll: bigint;
  debt: bigint;
  icr: bigint;
  icrBefore: bigint;
  liquidatable: boolean;
  redeemedMusd: bigint;
  redeemedBtc: bigint;
  bufferAfter: BufferReading | undefined;
  verdict: BufferVerdict;
  plan: PlanView;
  keeper: { action: "send" | "skip"; text: string };
  notes: string[];
}

const icrOf = (coll: bigint, debt: bigint, price: bigint) => (debt === 0n ? 2n ** 256n - 1n : (coll * price) / debt);

/**
 * Applies a price move and then redemption pressure to the position, and asks the planner port what the guardian
 * would do in the resulting state. It is a model with stated simplifications, not a forecast:
 * - the redemption fee, interest accruing and other troves' liquidations during the move are ignored;
 * - a price move does not change the buffer, though it would push other troves under 110% and out of the queue;
 * - redemption only reaches this trove when the queue walk was complete, since a lower bound proves nothing.
 */
export function whatIf(i: WhatIfInput): WhatIfResult {
  const notes: string[] = [];
  const price = (i.price * BigInt(100 + i.priceChangePct)) / 100n;
  const icrBefore = icrOf(i.coll, i.debt, i.price);

  let coll = i.coll;
  let debt = i.debt;
  let redeemedMusd = 0n;
  let redeemedBtc = 0n;
  let bufferAfter = i.buffer;
  let verdict: BufferVerdict = "unchecked";

  const b = i.buffer;
  if (b) {
    if (!b.inList) verdict = "not-queued";
    else {
      const used = (b.value * BigInt(i.redemptionPct)) / 100n;
      bufferAfter = { ...b, value: sub(b.value, used) };
      if (!b.complete) {
        verdict = "lower-bound";
        notes.push("The queue check was cut short, so the buffer is only a lower bound. Redemption cannot be shown to reach this position.");
      } else {
        const reach = sub(used, b.value);
        redeemedMusd = min(reach, sub(debt, GAS_COMPENSATION));
        redeemedBtc = price > 0n ? (redeemedMusd * WAD) / price : 0n;
        redeemedBtc = min(redeemedBtc, coll);
        debt -= redeemedMusd;
        coll -= redeemedBtc;
        if (redeemedMusd > 0n) verdict = "reached";
        else if (i.guardian && i.guardian.bufferFloorMusd > 0n && bufferAfter.value < i.guardian.bufferFloorMusd) verdict = "below-floor";
        else verdict = "holds";
      }
    }
  }

  const icr = icrOf(coll, debt, price);
  const liquidatable = debt > 0n && icr < LIMITS.mcr;
  if (i.recoveryMode) notes.push("The system is in Recovery Mode now. The contract may ask for a higher ratio than 110% before it acts, which this model does not know.");
  if (liquidatable) notes.push("Under 110% anyone can liquidate the trove. The guardian cannot add enough to bring it back above that line, so it holds.");

  const plan = planGuardian({ ...i, coll, debt, price }, bufferAfter);
  return { price, coll, debt, icr, icrBefore, liquidatable, redeemedMusd, redeemedBtc, bufferAfter, verdict, plan, keeper: keeperOutcome(i.guardian?.state, plan), notes };
}

/** The keeper's branch in `runOnce`: skip when the policy is not live or the planner says None, otherwise send `execute`. */
export function keeperOutcome(state: GuardianSetup["state"] | undefined, plan: PlanView): { action: "send" | "skip"; text: string } {
  if (state !== "live") return { action: "skip", text: "A keeper skips it: the policy is not live." };
  if (plan.kind === "None") return { action: "skip", text: `A keeper skips it: the planner says ${plan.reason}.` };
  return { action: "send", text: "A keeper that runs would send execute." };
}

/** Whether the model, run on today's numbers, gives the same plan as the contract's own `preview`. */
export function agreesWithPreview(model: PlanView, chain: PlanView | undefined): { agree: boolean; text: string } {
  if (!chain) return { agree: false, text: "The contract's preview could not be read, so the model could not be checked against it." };
  const same = model.kind === chain.kind && model.reason === chain.reason && model.amount === chain.amount && model.tip === chain.tip;
  return same
    ? { agree: true, text: "At today's numbers the model gives the same answer as the contract's own preview." }
    : { agree: false, text: `At today's numbers the model says ${model.kind}/${model.reason} but the contract's preview says ${chain.kind}/${chain.reason}. Treat the model with care.` };
}

