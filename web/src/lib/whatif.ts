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

/** What the vault's own queue check says about the redemption buffer: `PositionLens.Verdict`. */
export type Verdict = "Above" | "Below" | "Unknown";

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
  /**
   * The ratio an action has to reach: 110%, or the system ratio in Recovery Mode. The app cannot know the system
   * ratio at a price that has not happened, so it leaves this out and uses 110% (see `recoveryMode`).
   */
  minIcr?: bigint;
  /** The app knows the system is in Recovery Mode but not its ratio, so the answer may differ from the contract's. */
  recoveryMode: boolean;
  /**
   * The verdict `PositionLens.bufferAtLeast` gives for this state, when it was read from the chain. It is exact. Without
   * it the verdict is worked out from `buffer` (see `verdictFrom`), which is exact except in one case it reports.
   */
  verdict?: Verdict;
}

/** What the planner decided, with the one thing `execute` does on top of it: start a new spending window. */
export interface Planned extends PlanView {
  resetWindow: boolean;
}

/**
 * The verdict `PositionLens.bufferAtLeast(token, floor, maxWalkSteps)` would give, worked out from a buffer reading
 * made with a 100-step walk and no threshold. The contract walks the queue from its far end, adding each eligible
 * trove's debt, and says Above the moment the sum reaches the floor, Below only if it reaches the position without
 * getting there, and Unknown if it runs out of steps first.
 *
 * It is exact whenever the policy's walk is at least as long as the reading's. If the policy's walk is shorter than
 * the reading and the reading's sum is at or above the floor, the answer depends on the running sum at a step the
 * reading does not record (Above if it got there in time, Unknown if not). Then `exact` is false and the verdict is
 * Unknown, the cautious one: it never lets the guardian act on a doubt.
 */
export function verdictFrom(b: BufferReading | undefined, floor: bigint, maxWalkSteps: number): { verdict: Verdict; exact: boolean } {
  if (!b || !b.inList) return { verdict: "Unknown", exact: true };
  if (maxWalkSteps >= b.steps) {
    if (b.value >= floor) return { verdict: "Above", exact: true };
    // the reading walked every trove ahead (complete) and the policy's walk reaches them all: a proven low buffer
    if (b.complete) return { verdict: "Below", exact: true };
    return { verdict: "Unknown", exact: true };
  }
  if (b.value < floor) return { verdict: "Unknown", exact: true };
  return { verdict: "Unknown", exact: false };
}

/**
 * A port of `TrozuVault._plan`, branch for branch, over numbers handed in instead of read from the chain. The keeper
 * never re-derives a plan: it asks the vault's `preview` and sends `execute` when the kind is not None. This is that
 * decision, run on a state that does not exist yet. Where the contract walks the queue on chain, this takes the
 * walk's verdict (`state.verdict`) or works it out from the reading (`verdictFrom`).
 *
 * `web/src/lib/__fixtures__/planner-vectors.json` holds hundreds of states with the contract's own answers, written by
 * test/v2/PlannerVectors.t.sol, and `whatif.test.ts` replays every one of them against this function.
 */
export function planGuardian(s: PlannerState, bufferAfter: BufferReading | undefined = s.buffer): Planned {
  const none = (reason: Reason, icr = 0n, resetWindow = false): Planned => ({ kind: "None", reason, amount: 0n, tip: 0n, icr, resetWindow });
  const g = s.guardian;
  if (!g || g.state === "none") return none("NoPolicy");
  if (g.state === "stale") return none("PolicyStale");
  if (!s.active) return none("TroveInactive");
  if (s.debt === 0n) return none("Healthy");

  const icr = (s.coll * s.price) / s.debt;
  const belowFloor = icr < g.floorIcr;
  if (icr >= g.targetIcr || (!belowFloor && g.bufferFloorMusd === 0n)) return none("Healthy", icr);

  if (!belowFloor) {
    // redemption defense: only a complete walk that proves a low buffer may act. A verdict read from the chain only
    // describes the buffer as it was read, so it is not used once the caller has changed the buffer.
    const given = bufferAfter === s.buffer ? s.verdict : undefined;
    const v = given ?? verdictFrom(bufferAfter, g.bufferFloorMusd, g.maxWalkSteps).verdict;
    if (v !== "Below") return none(v === "Above" ? "Healthy" : "BufferUnknown", icr);
  }

  const fresh = s.now >= g.periodStart + BigInt(g.period);
  const remBtc = sub(g.periodCapBtc, fresh ? 0n : g.spentBtc);
  const remMusd = sub(g.periodCapMusd, fresh ? 0n : g.spentMusd);
  const tip = g.reserveBtc >= g.keeperTipBtc && remBtc >= g.keeperTipBtc ? g.keeperTipBtc : 0n;
  const tipFor = (valueBtc: bigint) => (valueBtc >= tip * MIN_ACTION_PER_TIP ? tip : 0n);
  const minIcr = s.minIcr ?? LIMITS.mcr;
  let blocked = false;

  // BTC first
  const room = min(min(sub(g.reserveBtc, tip), sub(remBtc, tip)), g.maxActionBtc);
  const need = sub(ceilDiv(g.targetIcr * s.debt, s.price), s.coll);
  const btc = min(room, need);
  if (btc > 0n) {
    if (((s.coll + btc) * s.price) / s.debt >= minIcr) {
      return { kind: belowFloor ? "TopUpBtc" : "DefendBtc", reason: "None", amount: btc, tip: tipFor(btc), icr, resetWindow: fresh };
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
        return { kind: "RepayMusd", reason: "None", amount: repay, tip: tipFor((repay * WAD) / s.price), icr, resetWindow: fresh };
      }
      blocked = true;
    }
  }
  return none(blocked ? "BelowMinimum" : "NoReserve", icr, fresh);
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

  const g2 = i.guardian;
  if (g2 && g2.state === "live" && g2.bufferFloorMusd > 0n && bufferAfter && !verdictFrom(bufferAfter, g2.bufferFloorMusd, g2.maxWalkSteps).exact) {
    notes.push("The queue check walked further than your policy lets the guardian walk, so the model cannot tell whether the guardian would see the buffer fall under the floor in time. It assumes it would not, and holds.");
  }
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

