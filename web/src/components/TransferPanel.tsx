"use client";

import { useState } from "react";
import { getAddress } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { positionNFTAbi } from "@/abi/keel";
import { config } from "@/config";
import { formatBps, formatBtc, formatIcr, formatMusd } from "@/lib/format";
import { riskOf } from "@/lib/risk";
import { isRisky, receiverProblem } from "@/lib/transfer";
import { friendlyError } from "@/lib/errors";
import { flyAway, pressPulse } from "@/lib/motion";
import { useTx } from "@/hooks/useTx";
import { assertFresh } from "@/lib/rpc";
import type { PositionInfo } from "@/hooks/usePositions";
import { TxStatus } from "./TxStatus";

type Step = "review" | "receiver" | "confirm";

const NO_DEBT = 2n ** 200n;

export function TransferPanel({
  p,
  stale = false,
  cardRef,
  onDone,
  onClose,
}: {
  p: PositionInfo;
  /** The data behind this panel is from a lagging node, so nothing can be confirmed. */
  stale?: boolean;
  cardRef: React.RefObject<HTMLElement | null>;
  onDone: () => void;
  onClose: () => void;
}) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const tx = useTx();

  const [step, setStep] = useState<Step>("review");
  const [ack, setAck] = useState("");
  const [to, setTo] = useState("");
  const [tail, setTail] = useState("");
  const [isContract, setIsContract] = useState(false);
  const [prepError, setPrepError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);

  const risk = riskOf(p.icr, p.active);
  const risky = isRisky(p);
  const blocked = stale;
  const noDebt = p.icr >= NO_DEBT;
  const problem = receiverProblem(to, address, p);
  const receiver = !problem ? getAddress(to.trim().toLowerCase()) : undefined;
  const reviewOk = !risky || ack.trim().toUpperCase() === "TRANSFER";
  const tailOk = receiver && tail.trim().toLowerCase() === receiver.slice(-4).toLowerCase();
  const done = tx.state.status === "success";

  const toConfirm = async () => {
    if (!receiver || !client) return;
    setChecking(true);
    try {
      const code = await client.getCode({ address: receiver });
      setIsContract(!!code && code !== "0x");
      setStep("confirm");
    } catch (e) {
      setPrepError(friendlyError(e).message);
    } finally {
      setChecking(false);
    }
  };

  const send = async () => {
    if (!client || !address || !receiver) return;
    setPrepError(undefined);
    setChecking(true);
    try {
      // one more look at the chain head right before anything is simulated or signed
      await assertFresh();
      const params = {
        address: config.keel.nft,
        abi: positionNFTAbi,
        functionName: "safeTransferFrom",
        args: [address, receiver, p.tokenId],
        chainId: config.chainId,
      } as const;
      // a contract that cannot receive NFTs makes safeTransferFrom revert, so find out before the wallet prompt
      await client.simulateContract({ ...params, account: address });
      setChecking(false);
      const receipt = await tx.send(params);
      if (receipt) {
        const el = cardRef.current;
        if (el) flyAway(el, onDone);
        else onDone();
      }
    } catch (e) {
      setPrepError(friendlyError(e).message);
    } finally {
      setChecking(false);
    }
  };

  const summary = (
    <dl className="preview">
      <div><dt>Collateral ratio</dt><dd className="mono">{stale || !p.priceOk ? "unverified" : noDebt ? "no debt" : formatIcr(p.icr)}</dd></div>
      <div><dt>Equity</dt><dd className="mono">{stale || !p.priceOk ? "unverified" : `$${formatMusd(p.equity)}`}</dd></div>
      <div><dt>Collateral</dt><dd className="mono">{formatBtc(p.coll)} BTC</dd></div>
      <div><dt>Debt</dt><dd className="mono">{formatMusd(p.debt)} MUSD</dd></div>
      <div><dt>Locked rate</dt><dd className="mono">{formatBps(p.lockedRateBps)}</dd></div>
    </dl>
  );

  return (
    <div className="transfer" role="dialog" aria-label={`Transfer position ${p.tokenId}`}>
      <header className="panel-head">
        <h4>Transfer position #{p.tokenId.toString()}</h4>
        {!tx.busy && !done && (
          <button className="link" onClick={onClose}>
            Cancel
          </button>
        )}
      </header>

      {stale && (
        <p className="banner warn" role="alert">
          The data for this position is from a node that is behind the chain, so its health cannot be confirmed. Wait for
          the page to refresh, then try again. Nothing can be sent until then.
        </p>
      )}

      {step === "review" && (
        <>
          <p className="note">
            The new holder gets everything: the collateral, the debt, the locked rate and every right over the vault. You
            keep nothing.
          </p>
          {summary}
          {!p.active && (
            <p className="banner warn">There is no open trove right now. Only the vault and any claimable collateral move.</p>
          )}
          {risky && (
            <div className="banner warn" role="alert">
              <span>
                {!p.priceOk
                  ? "The price feed is not answering, so the health of this position cannot be checked."
                  : p.equity <= 0n
                    ? "This position is underwater: its debt is worth more than its collateral."
                    : `This position is ${risk.label.toLowerCase()} at ${formatIcr(p.icr)}. The receiver may be liquidated soon.`}
              </span>
              <label className="field inline">
                <span>Type TRANSFER to continue</span>
                <input value={ack} onChange={(e) => setAck(e.target.value)} autoComplete="off" />
              </label>
            </div>
          )}
          <div className="actions">
            <button className="btn" disabled={!reviewOk || blocked} onClick={() => setStep("receiver")}>
              Continue
            </button>
          </div>
        </>
      )}

      {step === "receiver" && (
        <>
          <label className="field">
            <span>Receiver address</span>
            <input className="mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} aria-invalid={!!to && !!problem} />
          </label>
          {to && problem && <p className="note warn" role="alert">{problem}</p>}
          {prepError && <p className="note warn" role="alert">{prepError}</p>}
          <div className="actions">
            <button className="btn btn-quiet" onClick={() => setStep("review")}>Back</button>
            <button className="btn" disabled={!receiver || checking || blocked} onClick={toConfirm}>
              {checking ? "Checking…" : "Continue"}
            </button>
          </div>
        </>
      )}

      {step === "confirm" && receiver && (
        <>
          <p className="note">This sends position #{p.tokenId.toString()} to:</p>
          <p className="mono receiver" data-testid="receiver">{receiver}</p>
          {isContract && (
            <p className="banner warn">
              That address is a contract. It must be able to hold NFTs (implement onERC721Received) or the transfer reverts. It
              will be simulated first.
            </p>
          )}
          {summary}
          {!done && (
            <label className="field">
              <span>
                To confirm, type the last 4 characters of the address: <b className="mono">{receiver.slice(-4)}</b>
              </span>
              <input className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={4} autoComplete="off" spellCheck={false} />
            </label>
          )}
          {prepError && <p className="note warn" role="alert">{prepError}</p>}
          <TxStatus state={tx.state} successText="The position now belongs to the receiver." />
          {!done && (
            <div className="actions">
              <button className="btn btn-quiet" disabled={tx.busy || checking} onClick={() => { setStep("receiver"); tx.reset(); }}>
                Back
              </button>
              <button
                className="btn"
                disabled={!tailOk || tx.busy || checking || blocked}
                onClick={(e) => {
                  pressPulse(e.currentTarget);
                  void send();
                }}
              >
                {checking ? "Checking…" : tx.state.status === "failed" ? "Try again" : "Transfer position"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
