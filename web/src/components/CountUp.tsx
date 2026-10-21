"use client";

import { useEffect, useRef } from "react";
import { countTo } from "@/lib/motion";

/** A number that tweens to its new value instead of jumping. */
export function CountUp({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(0);

  useEffect(() => {
    if (!ref.current) return;
    countTo(ref.current, previous.current, value, format);
    previous.current = value;
    // format is a stable module-level function at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span ref={ref} className={className} suppressHydrationWarning>
      {format(value)}
    </span>
  );
}
