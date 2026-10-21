"use client";

import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { explorerTx } from "@/config";
import { prefersReducedMotion } from "@/lib/motion";
import { shortAddress } from "@/lib/format";
import type { TxState } from "@/hooks/useTx";

const LABEL: Record<string, string> = {
  signing: "Confirm in your wallet",
  pending: "Waiting for the network",
  success: "Done",
  failed: "Not completed",
};

/** Pending, success and failure of one transaction, with the hash linked to the explorer. */
export function TxStatus({ state, successText }: { state: TxState; successText?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const tick = useRef<SVGPathElement>(null);

  // each new state eases in; the success check draws itself
  useEffect(() => {
    if (state.status === "idle" || prefersReducedMotion()) return;
    if (box.current) animate(box.current, { opacity: [0, 1], translateY: [6, 0], duration: 280, ease: "outQuad" });
    if (state.status === "success" && tick.current) {
      const len = tick.current.getTotalLength();
      tick.current.style.strokeDasharray = `${len}`;
      animate(tick.current, { strokeDashoffset: [len, 0], duration: 520, delay: 120, ease: "outQuad" });
    }
  }, [state.status]);

  if (state.status === "idle") return null;

  const hash = "hash" in state ? state.hash : undefined;
  return (
    <div ref={box} className={`tx tx-${state.status}`} role={state.status === "failed" ? "alert" : "status"} aria-live="polite">
      <span className="tx-icon" aria-hidden>
        {(state.status === "signing" || state.status === "pending") && <i className="spinner" />}
        {state.status === "success" && (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path ref={tick} d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        )}
        {state.status === "failed" && (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        )}
      </span>
      <div className="tx-body">
        <b>{LABEL[state.status]}</b>
        {state.status === "success" && successText && <span>{successText}</span>}
        {state.status === "failed" && <span>{state.message}</span>}
        {state.status === "signing" && <span>Nothing is sent until you approve.</span>}
        {hash && (
          <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mono tx-hash">
            {shortAddress(hash)} on the explorer
          </a>
        )}
      </div>
    </div>
  );
}
