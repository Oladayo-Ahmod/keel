"use client";

import { useMemo, useState } from "react";
import { parseEventLogs } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { positionFactoryAbi } from "@/abi/keel";
import { config } from "@/config";
import { formatBtc, formatIcr, formatMusd } from "@/lib/format";
import { computeHints, nicrAfterOpen } from "@/lib/hints";
import { collForIcr, parseAmount, planOpen } from "@/lib/open";
import { friendlyError } from "@/lib/errors";
import { pressPulse } from "@/lib/motion";
import { useTx } from "@/hooks/useTx";
import { useOpenInputs } from "@/hooks/useChain";
import { assertFresh } from "@/lib/rpc";
import { TxStatus } from "./TxStatus";
import { GasRow } from "./GasRow";

const PRESETS = [150n, 160n, 200n];

/** Opens a position: form, review, then hints and simulation right before sending. */
export function OpenPosition({
  onOpened,
  factory = config.keel.factory,
  title = "Open a position",
}: {
  onOpened: () => void;
  /** The factory to open through: wave 1 by default. Both have the same openPosition signature. */
  factory?: `0x${string}`;
  title?: string;
}) {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const tx = useTx();

  const [debtText, setDebtText] = useState("1800");
  const [collText, setCollText] = useState("");
  const [review, setReview] = useState(false);
  const [prepError, setPrepError] = useState<string | undefined>();
  const [preparing, setPreparing] = useState(false);
  const [newId, setNewId] = useState<bigint | undefined>();

  const debt = parseAmount(debtText);
  const coll = parseAmount(collText);

  const inputs = useOpenInputs(address, debt);
  const freshRead = inputs.data;
  const stale = !!freshRead?.freshness.stale;
  const price = freshRead?.data.price;
  const minNet = freshRead?.data.minNetDebt;
  const fee = freshRead?.data.fee;
  const balance = freshRead?.data.balance;

  const ready = price !== undefined && minNet !== undefined && (fee !== undefined || !debt);
  const loadError = inputs.isError;

  // no plan, and so no ratio or "safe" wording, is produced from data a lagging node supplied
  const plan = useMemo(() => {
    if (stale || !ready || !debt || !coll || price === undefined || minNet === undefined || fee === undefined) return undefined;
    return planOpen({ debt, coll, price, fee, minNetDebt: minNet, balance: balance ?? 0n });
  }, [stale, ready, debt, coll, price, minNet, fee, balance]);

  const wrongNetwork = isConnected && chainId !== config.chainId;
  const canReview = isConnected && !wrongNetwork && !stale && !!plan && plan.errors.length === 0;

  const applyPreset = (pct: bigint) => {
    if (stale || !debt || price === undefined || fee === undefined) return;
    const c = collForIcr(debt, fee, price, (pct * 10n ** 18n) / 100n);
    setCollText((Number(c) / 1e18).toFixed(6));
  };

  const submit = async () => {
    if (!client || !address || !debt || !coll || fee === undefined) return;
    setPrepError(undefined);
    setPreparing(true);
    try {
      // one more look at the chain head, then hints computed now, not when the form was filled
      await assertFresh();
      const [upper, lower] = await computeHints(client, nicrAfterOpen(coll, debt, fee));
      const maxFee = fee + fee / 20n + 1n;
      const params = {
        address: factory,
        abi: positionFactoryAbi,
        functionName: "openPosition",
        args: [debt, upper, lower, maxFee],
        value: coll,
        chainId: config.chainId,
      } as const;
      await client.simulateContract({ ...params, account: address });
      setPreparing(false);
      const receipt = await tx.send(params);
      if (receipt) {
        const logs = parseEventLogs({ abi: positionFactoryAbi, logs: receipt.logs, eventName: "PositionCreated" });
        setNewId(logs[0]?.args.tokenId);
        onOpened();
      }
    } catch (e) {
      setPrepError(friendlyError(e).message);
    } finally {
      setPreparing(false);
    }
  };

  const done = tx.state.status === "success";

  return (
    <section className="glass panel" aria-label={title}>
      <header className="panel-head">
        <h2>{title}</h2>
        <p>Deposit BTC, borrow MUSD. You get an NFT that holds the whole position.</p>
      </header>

      {loadError && (
        <p className="banner warn" role="alert">
          Could not read prices or fees from the chain.{" "}
          <button className="link" onClick={() => void inputs.refetch()}>
            Try again
          </button>
        </p>
      )}
      {stale && (
        <p className="banner warn" role="alert">
          The node that answered is behind the chain, so the price, fee and ratio cannot be trusted. Nothing can be sent until a
          current node answers.{" "}
          <button className="link" onClick={() => void inputs.refetch()}>
            Check again
          </button>
        </p>
      )}

      {!review && !done && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canReview) setReview(true);
          }}
        >
          <label className="field">
            <span>Borrow (MUSD)</span>
            <input inputMode="decimal" value={debtText} onChange={(e) => setDebtText(e.target.value)} aria-invalid={debtText !== "" && !debt} />
          </label>
          <label className="field">
            <span>Collateral (BTC)</span>
            <input inputMode="decimal" placeholder="0.039" value={collText} onChange={(e) => setCollText(e.target.value)} aria-invalid={collText !== "" && !coll} />
          </label>
          <div className="presets" role="group" aria-label="Set collateral for a target ratio">
            {PRESETS.map((p) => (
              <button type="button" key={p.toString()} className="btn btn-quiet btn-small" disabled={!ready || !debt || stale} onClick={() => applyPreset(p)}>
                {p.toString()}% ratio
              </button>
            ))}
          </div>

          {plan && (
            <dl className="preview">
              <div><dt>Collateral ratio</dt><dd className="mono">{formatIcr(plan.icr)}</dd></div>
              <div><dt>Borrowing fee</dt><dd className="mono">{formatMusd(fee ?? 0n)} MUSD</dd></div>
              <div><dt>Total debt</dt><dd className="mono">{formatMusd(plan.composite)} MUSD</dd></div>
              <div><dt>Equity</dt><dd className="mono">${formatMusd(plan.equity)}</dd></div>
            </dl>
          )}
          {plan?.errors.map((m) => <p key={m} className="note warn" role="alert">{m}</p>)}
          {plan?.warnings.map((m) => <p key={m} className="note warn">{m}</p>)}
          {!isConnected && <p className="note">Connect a wallet to continue.</p>}
          {wrongNetwork && <p className="note warn" role="alert">Switch your wallet to {config.name} first.</p>}

          <button className="btn" type="submit" disabled={!canReview} onClick={(e) => pressPulse(e.currentTarget)}>
            Review
          </button>
        </form>
      )}

      {review && !done && plan && debt && coll && (
        <div className="review">
          <h3>Check before you send</h3>
          <dl className="preview">
            <div><dt>You deposit</dt><dd className="mono">{formatBtc(coll)} BTC</dd></div>
            <div><dt>You receive</dt><dd className="mono">{formatMusd(debt)} MUSD</dd></div>
            <div><dt>Debt owed</dt><dd className="mono">{formatMusd(plan.composite)} MUSD</dd></div>
            <div><dt>Collateral ratio</dt><dd className="mono">{formatIcr(plan.icr)}</dd></div>
            <GasRow fn="openPosition" />
          </dl>
          <p className="note">
            Debt includes the fee and Mezo&apos;s 200 MUSD liquidation reserve, which is returned when the trove closes. The
            interest rate locks at today&apos;s market rate and stays with the NFT.
          </p>
          <p className="note">Sorted-list hints are looked up when you press the button, so they reflect the list at that moment.</p>
          {prepError && <p className="note warn" role="alert">{prepError}</p>}
          <TxStatus state={tx.state} />
          <div className="actions">
            <button className="btn btn-quiet" disabled={tx.busy || preparing} onClick={() => { setReview(false); tx.reset(); setPrepError(undefined); }}>
              Back
            </button>
            <button className="btn" disabled={tx.busy || preparing} onClick={submit}>
              {preparing ? "Checking…" : tx.state.status === "failed" ? "Try again" : "Open position"}
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="review">
          <TxStatus state={tx.state} successText={newId !== undefined ? `Position #${newId.toString()} is yours.` : "Your position is open."} />
          <button className="btn btn-quiet" onClick={() => { tx.reset(); setReview(false); setCollText(""); setNewId(undefined); }}>
            Open another
          </button>
        </div>
      )}
    </section>
  );
}
