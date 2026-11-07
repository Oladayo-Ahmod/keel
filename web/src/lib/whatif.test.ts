import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kindName, reasonName } from "./guardian";
import { agreesWithPreview, keeperOutcome, planGuardian, verdictFrom, whatIf, type GuardianSetup, type PlannerState, type Verdict, type WhatIfInput } from "./whatif";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const guardian: GuardianSetup = {
  state: "live",
  floorIcr: e18(1.3), targetIcr: e18(1.6),
  maxActionBtc: e18(0.05), maxActionMusd: e18(500),
  periodCapBtc: e18(0.1), periodCapMusd: e18(1_000),
  keeperTipBtc: e18(0.00005), bufferFloorMusd: 0n,
  period: 86_400, maxWalkSteps: 50,
  reserveBtc: e18(0.1), reserveMusd: e18(500),
  spentBtc: 0n, spentMusd: 0n, periodStart: 1_000n,
};

// 0.05 BTC at 80,000 is 4,000 of collateral against 2,000 of debt: 200%
const base: PlannerState = {
  active: true, coll: e18(0.05), debt: e18(2_000), price: e18(80_000),
  guardian, now: 2_000n, minNetDebt: e18(1_800) - e18(200), buffer: undefined, recoveryMode: false,
};

const withG = (g: Partial<GuardianSetup>, s: Partial<PlannerState> = {}): PlannerState => ({ ...base, ...s, guardian: { ...guardian, ...g } });
// price chosen so the ratio is exactly the given value
const atIcr = (icr: number, g: Partial<GuardianSetup> = {}, s: Partial<PlannerState> = {}) =>
  withG(g, { price: (e18(icr) * e18(2_000)) / e18(0.05), ...s });

describe("planner port, branch by branch", () => {
  it("no policy and a stale policy never act", () => {
    expect(planGuardian({ ...base, guardian: undefined }).reason).toBe("NoPolicy");
    expect(planGuardian(withG({ state: "none" })).reason).toBe("NoPolicy");
    expect(planGuardian(withG({ state: "stale" })).reason).toBe("PolicyStale");
  });

  it("does nothing for a closed trove or a trove with no debt", () => {
    expect(planGuardian({ ...base, active: false }).reason).toBe("TroveInactive");
    expect(planGuardian({ ...base, debt: 0n }).reason).toBe("Healthy");
  });

  it("holds when the ratio is at or above the floor and redemption defense is off", () => {
    const p = planGuardian(base);
    expect(p).toMatchObject({ kind: "None", reason: "Healthy" });
    expect(planGuardian(atIcr(1.3)).reason).toBe("Healthy");
  });

  it("tops up BTC to the target when below the floor and the caps allow it", () => {
    const s = atIcr(1.2);
    const p = planGuardian(s);
    expect(p.kind).toBe("TopUpBtc");
    // exact: ceil(target * debt / price) - coll
    const need = (e18(1.6) * s.debt + s.price - 1n) / s.price - s.coll;
    expect(p.amount).toBe(need);
    expect((s.coll + p.amount) * s.price / s.debt).toBeGreaterThanOrEqual(e18(1.6));
    expect(p.tip).toBe(e18(0.00005));
  });

  it("limits a top-up to the per-action cap", () => {
    const p = planGuardian(atIcr(1.2, { maxActionBtc: e18(0.002) }));
    expect(p).toMatchObject({ kind: "TopUpBtc", amount: e18(0.002) });
  });

  it("limits a top-up to what is left of the period allowance, less the tip", () => {
    const p = planGuardian(atIcr(1.2, { periodCapBtc: e18(0.1), spentBtc: e18(0.099) }));
    expect(p.amount).toBe(e18(0.001) - e18(0.00005));
  });

  it("starts a fresh allowance once the period has passed", () => {
    const spent = { periodCapBtc: e18(0.1), spentBtc: e18(0.1) };
    expect(planGuardian(atIcr(1.2, spent)).kind).not.toBe("TopUpBtc");
    expect(planGuardian(atIcr(1.2, { ...spent, periodStart: 0n, period: 1_000 }, { now: 1_000n })).kind).toBe("TopUpBtc");
    expect(planGuardian(atIcr(1.2, { ...spent, periodStart: 0n, period: 1_001 }, { now: 1_000n })).kind).not.toBe("TopUpBtc");
  });

  it("pays no tip when the reserve cannot cover it", () => {
    const p = planGuardian(atIcr(1.2, { reserveBtc: e18(0.00004) }));
    expect(p.tip).toBe(0n);
    expect(p.amount).toBe(e18(0.00004));
  });

  it("pays no tip for a dust action worth under ten tips", () => {
    // ratio a hair under the floor so the needed top-up is tiny
    const s = atIcr(1.2999, { floorIcr: e18(1.3), targetIcr: e18(1.3001) });
    const p = planGuardian(s);
    expect(p.kind).toBe("TopUpBtc");
    expect(p.amount).toBeLessThan(e18(0.0005));
    expect(p.tip).toBe(0n);
  });

  it("falls back to a MUSD repay when the BTC reserve is empty", () => {
    const s = atIcr(1.2, { reserveBtc: 0n, keeperTipBtc: 0n });
    const p = planGuardian(s);
    expect(p.kind).toBe("RepayMusd");
    expect(p.amount).toBeLessThanOrEqual(e18(500));
    expect((s.coll * s.price) / (s.debt - p.amount)).toBeGreaterThanOrEqual(e18(1.1));
  });

  it("keeps net debt above Mezo's minimum when repaying", () => {
    const s = atIcr(1.2, { reserveBtc: 0n, keeperTipBtc: 0n, maxActionMusd: e18(5_000), periodCapMusd: e18(5_000), reserveMusd: e18(5_000) });
    const p = planGuardian(s);
    expect(s.debt - p.amount).toBeGreaterThanOrEqual(e18(1_800) - e18(200) + e18(200));
  });

  it("values a repay's tip in BTC", () => {
    // 200 MUSD at 80,000 is 0.0025 BTC, over ten tips of 0.00005
    const p = planGuardian(atIcr(1.2, { reserveBtc: e18(0.00005), keeperTipBtc: e18(0.00005), maxActionMusd: e18(200) }));
    expect(p.kind).toBe("RepayMusd");
    expect(p.tip).toBe(e18(0.00005));
  });

  it("reports NoReserve when nothing is left to spend", () => {
    expect(planGuardian(atIcr(1.2, { reserveBtc: 0n, reserveMusd: 0n })).reason).toBe("NoReserve");
  });

  it("reports BelowMinimum when every action would still leave the ratio under 110%", () => {
    // 102% with a tiny action cap: neither a top-up nor a repay reaches 110%
    const p = planGuardian(atIcr(1.02, { maxActionBtc: e18(0.0005), maxActionMusd: e18(10) }));
    expect(p.reason).toBe("BelowMinimum");
    expect(p.kind).toBe("None");
  });

  it("acts on a ratio between 110% and the floor, not under it", () => {
    expect(planGuardian(atIcr(1.15)).kind).toBe("TopUpBtc");
  });
});

describe("planner port, redemption defense", () => {
  const defend = (buffer: PlannerState["buffer"], g: Partial<GuardianSetup> = {}) =>
    planGuardian(atIcr(1.4, { bufferFloorMusd: e18(1_000), ...g }, { buffer }));

  it("acts only when a complete walk shows the buffer under the floor", () => {
    expect(defend({ inList: true, value: e18(400), complete: true, steps: 10 })).toMatchObject({ kind: "DefendBtc" });
  });

  it("holds when the buffer is at or above the floor", () => {
    expect(defend({ inList: true, value: e18(1_000), complete: true, steps: 10 }).reason).toBe("Healthy");
    expect(defend({ inList: true, value: e18(5_000), complete: false, steps: 50 }).reason).toBe("Healthy");
  });

  it("refuses to act on an incomplete walk, or one longer than the policy allows", () => {
    expect(defend({ inList: true, value: e18(400), complete: false, steps: 50 }).reason).toBe("BufferUnknown");
    expect(defend({ inList: true, value: e18(400), complete: true, steps: 60 }, { maxWalkSteps: 50 }).reason).toBe("BufferUnknown");
  });

  it("refuses when the buffer was never read or the trove is not queued", () => {
    expect(defend(undefined).reason).toBe("BufferUnknown");
    expect(defend({ inList: false, value: 0n, complete: false, steps: 0 }).reason).toBe("BufferUnknown");
  });

  it("only raises the ratio up to the target, and ignores the buffer once at target", () => {
    expect(planGuardian(atIcr(1.7, { bufferFloorMusd: e18(1_000) }, { buffer: { inList: true, value: 0n, complete: true, steps: 1 } })).reason).toBe("Healthy");
  });

  it("is off when the floor is zero", () => {
    expect(planGuardian(atIcr(1.4, {}, { buffer: { inList: true, value: 0n, complete: true, steps: 1 } })).reason).toBe("Healthy");
  });
});

describe("what-if model", () => {
  const input = (o: Partial<WhatIfInput> = {}): WhatIfInput => ({ ...base, priceChangePct: 0, redemptionPct: 0, ...o });
  const buffer = { inList: true, value: e18(10_000), complete: true, steps: 20 };

  it("changes nothing at zero and agrees with a plain planner call", () => {
    const r = whatIf(input());
    expect(r.price).toBe(base.price);
    expect(r.icr).toBe(r.icrBefore);
    expect(r.plan).toEqual(planGuardian(base));
  });

  it("moves the ratio with the price", () => {
    const r = whatIf(input({ priceChangePct: -30 }));
    expect(r.price).toBe(e18(56_000));
    expect(r.icr).toBe(e18(1.4));
    // 140% is above the 130% floor, so the guardian holds
    expect(r.plan.reason).toBe("Healthy");
    expect(r.liquidatable).toBe(false);
  });

  it("makes the guardian act once the drop crosses the floor", () => {
    const r = whatIf(input({ priceChangePct: -40 }));
    expect(r.icr).toBe(e18(1.2));
    expect(r.plan.kind).toBe("TopUpBtc");
    expect(r.keeper.action).toBe("send");
  });

  it("flags liquidation under 110% and shows the guardian refusing when it cannot reach the line", () => {
    const r = whatIf(input({ priceChangePct: -55, guardian: { ...guardian, maxActionBtc: e18(0.0005), maxActionMusd: e18(5) } }));
    expect(r.liquidatable).toBe(true);
    expect(r.plan.reason).toBe("BelowMinimum");
    expect(r.keeper.action).toBe("skip");
    expect(r.notes.join(" ")).toMatch(/liquidate/);
  });

  it("moves the price up too", () => {
    expect(whatIf(input({ priceChangePct: 25 })).icr).toBe(e18(2.5));
  });

  it("uses part of the buffer without reaching the trove", () => {
    const r = whatIf(input({ buffer, redemptionPct: 60 }));
    expect(r.bufferAfter?.value).toBe(e18(4_000));
    expect(r.verdict).toBe("holds");
    expect(r.redeemedMusd).toBe(0n);
  });

  it("takes debt and collateral from the trove once the buffer is used up", () => {
    const r = whatIf(input({ buffer, redemptionPct: 100 + 5 }));
    // 105% of 10,000 is 10,500: 500 MUSD reach the trove, at 80,000 per BTC
    expect(r.redeemedMusd).toBe(e18(500));
    expect(r.redeemedBtc).toBe(e18(500) * 10n ** 18n / e18(80_000));
    expect(r.debt).toBe(e18(1_500));
    expect(r.coll).toBe(e18(0.05) - r.redeemedBtc);
    expect(r.verdict).toBe("reached");
  });

  it("never redeems the 200 MUSD gas compensation", () => {
    const r = whatIf(input({ buffer, redemptionPct: 200, debt: e18(2_000) }));
    expect(r.redeemedMusd).toBe(e18(1_800));
    expect(r.debt).toBe(e18(200));
  });

  it("does not claim redemption reaches the trove from a lower bound", () => {
    const r = whatIf(input({ buffer: { ...buffer, complete: false }, redemptionPct: 200 }));
    expect(r.verdict).toBe("lower-bound");
    expect(r.redeemedMusd).toBe(0n);
    expect(r.debt).toBe(base.debt);
  });

  it("says nothing about the queue when the buffer was not checked, or the trove is not queued", () => {
    expect(whatIf(input({ redemptionPct: 80 })).verdict).toBe("unchecked");
    expect(whatIf(input({ buffer: { inList: false, value: 0n, complete: false, steps: 0 }, redemptionPct: 80 })).verdict).toBe("not-queued");
  });

  it("drives redemption defense: pressure takes the buffer under the floor and the guardian defends", () => {
    const g = { ...guardian, bufferFloorMusd: e18(5_000) };
    const calm = whatIf(input({ guardian: g, buffer, priceChangePct: -30, redemptionPct: 0 }));
    expect(calm.plan.reason).toBe("Healthy");
    const pressed = whatIf(input({ guardian: g, buffer, priceChangePct: -30, redemptionPct: 70 }));
    expect(pressed.verdict).toBe("below-floor");
    expect(pressed.plan.kind).toBe("DefendBtc");
  });

  it("works with no guardian at all", () => {
    const r = whatIf(input({ guardian: undefined, priceChangePct: -40 }));
    expect(r.plan.reason).toBe("NoPolicy");
    expect(r.keeper.text).toMatch(/not live/);
  });

  it("warns that Recovery Mode may change the line", () => {
    expect(whatIf(input({ recoveryMode: true })).notes.join(" ")).toMatch(/Recovery Mode/);
  });
});

describe("keeper outcome and preview check", () => {
  const act = { kind: "TopUpBtc" as const, reason: "None" as const, amount: 5n, tip: 1n, icr: 9n };
  const hold = { kind: "None" as const, reason: "Healthy" as const, amount: 0n, tip: 0n, icr: 9n };

  it("mirrors the keeper's branches", () => {
    expect(keeperOutcome("live", act).action).toBe("send");
    expect(keeperOutcome("live", hold).text).toMatch(/planner says Healthy/);
    expect(keeperOutcome("stale", act).action).toBe("skip");
    expect(keeperOutcome(undefined, act).action).toBe("skip");
  });

  it("compares the model with the contract's preview", () => {
    expect(agreesWithPreview(act, { ...act, icr: 0n }).agree).toBe(true);
    expect(agreesWithPreview(act, hold).agree).toBe(false);
    expect(agreesWithPreview(act, undefined).agree).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Golden vectors: states the contract itself was asked about. test/v2/PlannerVectors.t.sol builds each one on the local
// MUSD deployment, calls TrozuVault.preview() and writes the state and the answer; every one is replayed here.
// ---------------------------------------------------------------------------------------------------------------------

interface RawVector {
  id: number;
  mode: number;
  tags: string;
  state: {
    active: boolean; coll: string; debt: string; price: string; now: string; minNetDebt: string; minIcr: string;
    policyState: "none" | "stale" | "live";
    policy: Record<string, string | number>;
    buffer: { inList: boolean; value: string; complete: boolean; steps: number } | null;
    verdict: Verdict | "None";
  };
  expected: { kind: number; reason: number; amount: string; tip: string; icr: string; resetWindow: boolean };
}

const vectors = JSON.parse(readFileSync(new URL("./__fixtures__/planner-vectors.json", import.meta.url), "utf8")) as RawVector[];

function stateOf(v: RawVector): PlannerState {
  const p = v.state.policy;
  const big = (k: string) => BigInt(p[k] as string);
  return {
    active: v.state.active,
    coll: BigInt(v.state.coll),
    debt: BigInt(v.state.debt),
    price: BigInt(v.state.price),
    now: BigInt(v.state.now),
    minNetDebt: BigInt(v.state.minNetDebt),
    minIcr: BigInt(v.state.minIcr),
    recoveryMode: false,
    buffer: v.state.buffer ? { inList: v.state.buffer.inList, value: BigInt(v.state.buffer.value), complete: v.state.buffer.complete, steps: v.state.buffer.steps } : undefined,
    guardian: {
      state: v.state.policyState,
      floorIcr: big("floorIcr"), targetIcr: big("targetIcr"), maxActionBtc: big("maxActionBtc"), maxActionMusd: big("maxActionMusd"),
      periodCapBtc: big("periodCapBtc"), periodCapMusd: big("periodCapMusd"), keeperTipBtc: big("keeperTipBtc"), bufferFloorMusd: big("bufferFloorMusd"),
      period: Number(p.period), maxWalkSteps: Number(p.maxWalkSteps),
      reserveBtc: big("reserveBtc"), reserveMusd: big("reserveMusd"), spentBtc: big("spentBtc"), spentMusd: big("spentMusd"), periodStart: big("periodStart"),
    },
  };
}

const answerOf = (v: RawVector) => ({
  kind: kindName(v.expected.kind), reason: reasonName(v.expected.reason),
  amount: BigInt(v.expected.amount), tip: BigInt(v.expected.tip), icr: BigInt(v.expected.icr), resetWindow: v.expected.resetWindow,
});
const fmt = (a: object) => JSON.stringify(a, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

describe("planner port against the contract's golden vectors", () => {
  it("has enough vectors, and every branch the port has to match is among them", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(400);
    const tags = new Set(vectors.flatMap((v) => v.tags.split(",").filter(Boolean)));
    for (const t of [
      "kind-topup", "kind-repay", "kind-defend", "hold-healthy", "reason-below-minimum", "reason-no-reserve", "reason-buffer-unknown",
      "reason-no-policy", "reason-stale", "reason-inactive", "verdict-above", "verdict-below", "verdict-unknown", "bind-need", "bind-reserve",
      "bind-period", "bind-maxaction", "bind-mindebt", "tip-paid", "tip-dust", "tip-reserve-short", "recovery-mode",
    ]) expect(tags.has(t), t).toBe(true);
  });

  it("gives the contract's answer for every vector when the contract's own redemption verdict is supplied", () => {
    const wrong: string[] = [];
    for (const v of vectors) {
      const st = stateOf(v);
      const got = planGuardian({ ...st, verdict: v.state.verdict === "None" ? undefined : v.state.verdict });
      const want = answerOf(v);
      if (fmt(got) !== fmt(want)) wrong.push(`vector ${v.id} (${v.tags}): contract ${fmt(want)}, port ${fmt(got)}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong.length).toBe(0);
  });

  it("works out the redemption verdict from a buffer reading exactly, except in the one case it says it cannot", () => {
    let exact = 0;
    let doubtful = 0;
    const wrong: string[] = [];
    for (const v of vectors) {
      if (v.state.verdict === "None" || !v.state.buffer) continue;
      const g = stateOf(v).guardian!;
      const d = verdictFrom(stateOf(v).buffer, g.bufferFloorMusd, g.maxWalkSteps);
      if (d.exact) {
        exact++;
        if (d.verdict !== v.state.verdict) wrong.push(`vector ${v.id}: contract ${v.state.verdict}, derived ${d.verdict}`);
      } else {
        doubtful++;
        // the cautious answer, and the contract can only have said Above or Unknown here, never Below
        if (d.verdict !== "Unknown" || v.state.verdict === "Below") wrong.push(`vector ${v.id}: doubtful case came out ${d.verdict} against the contract's ${v.state.verdict}`);
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(exact).toBeGreaterThan(100);
    console.log(`verdicts derived from a buffer reading: ${exact} exact, ${doubtful} doubtful (all cautious)`);
  });

  it("without the contract's verdict, only a doubtful verdict can make the port differ, and then only towards holding", () => {
    let differ = 0;
    for (const v of vectors) {
      const st = stateOf(v);
      const got = planGuardian(st);
      const want = answerOf(v);
      if (fmt(got) === fmt(want)) continue;
      differ++;
      const g = st.guardian!;
      const d = verdictFrom(st.buffer, g.bufferFloorMusd, g.maxWalkSteps);
      expect(d.exact, `vector ${v.id} differs for a reason other than the verdict: ${fmt(want)} vs ${fmt(got)}`).toBe(false);
      expect(got.kind, `vector ${v.id}: the port acted where the contract did not`).toBe("None");
      expect(got.reason).toBe("BufferUnknown");
      expect(want.kind === "None" ? want.reason : "acted").not.toBe("BufferUnknown");
    }
    console.log(`vectors where the derived verdict changes the answer: ${differ} of ${vectors.length}`);
  });
});
