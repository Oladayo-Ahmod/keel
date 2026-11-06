"use client";

import { useEffect, useId, useRef, useState } from "react";
import { TIPS, type TipKey } from "@/lib/glossary";

/**
 * A small "?" that explains a term. It opens on hover, on keyboard focus and on tap, and closes
 * on Escape or a tap elsewhere, so it works with a mouse, a keyboard and a phone.
 */
export function Tip({ term, label }: { term: TipKey; label: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span className="tip" ref={box} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="tip-btn"
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open && (
        <span id={id} role="tooltip" className="tip-body">
          {TIPS[term]}
        </span>
      )}
    </span>
  );
}
