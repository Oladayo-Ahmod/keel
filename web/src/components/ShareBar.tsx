"use client";

import { useState } from "react";
import { pressPulse } from "@/lib/motion";

/** The link to this page and its preview image. Copying only needs the page's own address, nothing is sent anywhere. */
export function ShareBar({ imagePath }: { imagePath: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (el: HTMLElement) => {
    pressPulse(el);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="share" role="group" aria-label="Share this page">
      <button type="button" className="btn btn-small" onClick={(e) => void copy(e.currentTarget)}>Copy link</button>
      <a className="btn btn-quiet btn-small" href={imagePath} target="_blank" rel="noreferrer">Preview image</a>
      <span className="note" role="status">
        {state === "copied" && "Link copied."}
        {state === "failed" && "Could not copy. Copy the address from the browser bar."}
        {state === "idle" && "The image shows only public on-chain values."}
      </span>
    </div>
  );
}
