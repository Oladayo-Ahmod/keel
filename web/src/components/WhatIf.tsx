"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import { positionLensAbi } from "@/abi/keel";
import { borrowerOperationsAbi } from "@/abi/mezo";
import { config } from "@/config";
import { wave2 } from "@/config/wave2";
import { useGuardian, type GuardianState } from "@/hooks/useGuardian";
import type { PositionInfo } from "@/hooks/usePositions";
import { describePlan } from "@/lib/guardian";
import { formatBtc, formatIcr, formatMusd, toNumber } from "@/lib/format";
import { pressPulse, revealIn } from "@/lib/motion";
import { riskOf } from "@/lib/risk";
import { agreesWithPreview, whatIf, type BufferReading, type BufferVerdict, type GuardianSetup } from "@/lib/whatif";
import { CountUp } from "./CountUp";
import { Tip } from "./Tip";

const pct = (n: number) => `${n > 0 ? "+" : ""}${n}%`;
const ratio = (n: number) => `${(n * 100).toFixed(1)}%`;

const VERDICT: Record<BufferVerdict, string> = {
  unchecked: "Check the buffer to model redemptions.",
  "not-queued": "This trove is not in the redemption queue.",
  "lower-bound": "The queue check was cut short, so redemption cannot be shown to reach this position.",
  holds: "The buffer holds. Redeemers do not reach this position.",
  "below-floor": "The buffer falls under your redemption-defense floor.",
  reached: "Redeemers get through the queue and take collateral from this position.",
};

/** Turns the vault's stored policy and reserve into the planner's input. */
export function setupOf(g: GuardianState): GuardianSetup {
  const p = g.policy;
  return {
    state: !p.active ? "none" : g.live ? "live" : "stale",
    floorIcr: p.floorIcr, targetIcr: p.targetIcr,
    maxActionBtc: p.maxActionBtc, maxActionMusd: p.maxActionMusd,
    periodCapBtc: p.periodCapBtc, periodCapMusd: p.periodCapMusd,
    keeperTipBtc: p.keeperTipBtc, bufferFloorMusd: p.bufferFloorMusd,
    period: p.period, maxWalkSteps: p.maxWalkSteps,
    reserveBtc: g.reserveBtc, reserveMusd: g.reserveMusd, spentBtc: g.spentBtc, spentMusd: g.spentMusd, periodStart: g.periodStart,
  };
}

/** The guardian is only read for wave 2 vaults, so this wrapper is the one that calls the hook. */
export function WhatIf({ p, v2 }: { p: PositionInfo; v2: boolean }) {
  return v2 && wave2.enabled ? <WhatIfWithGuardian p={p} /> : <WhatIfBody p={p} guardian={undefined} chainPlan={undefined} />;
}

function WhatIfWithGuardian({ p }: { p: PositionInfo }) {
  const q = useGuardian(p.vault, p.tokenId);
  const g = q.data?.data;
  return <WhatIfBody p={p} guardian={g ? setupOf(g) : undefined} chainPlan={g?.plan} loading={q.isPending} />;
}

export function WhatIfBody({
  p,
  guardian,
  chainPlan,
  loading = false,
  fixture,
}: {
  p: PositionInfo;
  guardian: GuardianSetup | undefined;
  chainPlan: GuardianState["plan"];
  loading?: boolean;
  /** Layout fixture only: numbers that stand in for the two chain reads. */
  fixture?: { minNetDebt: bigint; buffer: BufferReading };
}) {
  const [priceMove, setPriceMove] = useState(0);
  const [pressure, setPressure] = useState(0);
  const [asked, setAsked] = useState(false);
  const out = useRef<HTMLDListElement>(null);

  const minNet = useReadContract({
    address: config.mezo.borrowerOperations,
    abi: borrowerOperationsAbi,
    functionName: "minNetDebt",
    query: { enabled: p.active && !fixture },
  });
  // same read and arguments as the buffer panel, so a check made in either place serves both
  const buf = useReadContract({
    address: config.keel.lens,
    abi: positionLensAbi,
    functionName: "redemptionBuffer",
    args: [p.tokenId, 100n],
    query: { enabled: asked && p.active && !fixture },
  });
  const b = buf.data as { buffer: bigint; steps: bigint; complete: boolean; inList: boolean } | undefined;
  const buffer: BufferReading | undefined = fixture
    ? fixture.buffer
    : b
      ? { inList: b.inList, value: b.buffer, complete: b.complete, steps: Number(b.steps) }
      : undefined;
  const minNetDebt = fixture ? fixture.minNetDebt : (minNet.data as bigint | undefined);

  const run = (priceChangePct: number, redemptionPct: number) =>
    whatIf({
      active: p.active, coll: p.coll, debt: p.debt, price: p.price, guardian, now: BigInt(Math.floor(Date.now() / 1000)),
      minNetDebt: minNetDebt!, buffer, recoveryMode: p.recoveryMode, priceChangePct, redemptionPct,
    });

  const result = useMemo(
    () => (!p.active || !p.priceOk || minNetDebt === undefined ? undefined : run(priceMove, pressure)),
    // run closes over the same inputs listed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p, guardian, minNetDebt, buffer, priceMove, pressure],
  );

  // today's numbers through the model, to compare with the contract's own preview
  const check = useMemo(() => {
    if (!result || !guardian || guardian.state !== "live") return undefined;
    return agreesWithPreview(run(0, 0).plan, chainPlan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, guardian, chainPlan]);

  const atRest = priceMove === 0 && pressure === 0;
  useEffect(() => revealIn(out.current), [atRest, !!result]);

  if (!p.active) return null;
  const noBuffer = !buffer || !buffer.inList;
  const risk = result ? riskOf(result.icr, true) : undefined;

  return (
    <section className="block" aria-label="What-if simulator">
      <h4>What if<Tip term="icr" label="the collateral ratio" /></h4>
      <p className="note">
        <span className="chip chip-none">Model, not a prediction</span> Drag to see how this position and its guardian would respond to a made-up
        move. Nobody knows what the price or redeemers will do.
      </p>

      <div className="slider">
        <label htmlFor={`pm-${p.tokenId}`}>
          <span>BTC price</span><b className="mono">{pct(priceMove)}</b>
        </label>
        <input id={`pm-${p.tokenId}`} type="range" min={-80} max={50} step={1} value={priceMove} onChange={(e) => setPriceMove(Number(e.target.value))} aria-valuetext={`${pct(priceMove)} from today's price`} />
      </div>

      <div className="slider">
        <label htmlFor={`rp-${p.tokenId}`}>
          <span>Redemption pressure</span><b className="mono">{pressure}% of the buffer</b>
        </label>
        <input id={`rp-${p.tokenId}`} type="range" min={0} max={150} step={1} value={pressure} disabled={noBuffer} onChange={(e) => setPressure(Number(e.target.value))} aria-valuetext={`${pressure}% of the redemption buffer used`} />
        {!buffer && (
          <button type="button" className="btn btn-quiet btn-small" onClick={(e) => { pressPulse(e.currentTarget); setAsked(true); }} disabled={buf.isLoading}>
            {buf.isLoading ? "Checking the queue…" : "Check buffer to enable"}
          </button>
        )}
        {buf.error && <p className="note warn" role="alert">The queue check failed. <button className="link" onClick={() => void buf.refetch()}>Retry</button></p>}
        {buffer && !buffer.inList && <p className="note">This trove is not in the redemption queue, so there is nothing to model.</p>}
        {buffer && buffer.inList && (
          <p className="note">
            Buffer now: {buffer.complete ? "" : "at least "}<b className="mono">{formatMusd(buffer.value)} MUSD</b> ahead of this position. 100% means redeemers use all of it.
          </p>
        )}
      </div>

      {!atRest && (
        <button type="button" className="btn btn-quiet btn-small" onClick={() => { setPriceMove(0); setPressure(0); }}>Reset</button>
      )}

      {!fixture && minNet.isError && <p className="note warn" role="alert">Could not read Mezo&apos;s minimum debt, so the model cannot run. <button className="link" onClick={() => void minNet.refetch()}>Retry</button></p>}
      {!p.priceOk && <p className="note warn" role="alert">The price feed did not answer, so there is nothing to start from.</p>}

      {result && risk && (
        <dl ref={out} className="preview whatif-out" aria-live="polite">
          <div><dt>BTC price</dt><dd className="mono">${formatMusd(result.price)}</dd></div>
          <div>
            <dt>Collateral ratio</dt>
            <dd>
              <CountUp className="mono" value={toNumber(result.icr)} format={ratio} />
              <span className={`chip chip-${risk.level}`}>{risk.label}</span>
              <small className="note"> was {formatIcr(result.icrBefore)}</small>
            </dd>
          </div>
          <div><dt>Collateral</dt><dd className="mono">{formatBtc(result.coll)} BTC</dd></div>
          <div><dt>Debt</dt><dd className="mono">{formatMusd(result.debt)} MUSD</dd></div>
          {result.redeemedMusd > 0n && (
            <div className="wide"><dt>Redeemed from you</dt><dd className="mono">{formatMusd(result.redeemedMusd)} MUSD for {formatBtc(result.redeemedBtc)} BTC</dd></div>
          )}
          <div className="wide">
            <dt>Redemption buffer</dt>
            <dd>
              {result.bufferAfter && result.bufferAfter.inList && <span className="mono">{result.bufferAfter.complete ? "" : "≥ "}{formatMusd(result.bufferAfter.value)} MUSD left. </span>}
              <span>{VERDICT[result.verdict]}</span>
            </dd>
          </div>
          <div className="wide">
            <dt>Guardian</dt>
            <dd>
              {guardian ? describePlan(result.plan) : loading ? "Reading the guardian…" : "This position has no guardian, so nothing would act."}
              {guardian && <><br /><small className="note">{result.keeper.text}</small></>}
            </dd>
          </div>
        </dl>
      )}

      {result?.notes.map((n) => <p key={n} className="note warn">{n}</p>)}
      {check && <p className={`note ${check.agree ? "good" : "warn"}`}>{check.text}</p>}
      <p className="note">
        The model leaves out the redemption fee, interest over time and other troves being liquidated. A price move does not change the buffer here, though it
        would push other troves out of the queue. The guardian only acts when someone calls it.
      </p>
    </section>
  );
}
