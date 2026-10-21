"use client";

import type { ReactNode } from "react";

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="glass skeleton" style={{ height }} aria-hidden />;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="glass state" role="status">
      <div className="state-mark" aria-hidden>
        <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M6 28c6 8 14 12 18 12s12-4 18-12H6Z" strokeLinejoin="round" />
          <path d="M24 8v20M24 8c4 6 8 12 12 20M24 8c-4 6-8 12-12 20" strokeLinejoin="round" />
        </svg>
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="glass state state-error" role="alert">
      <h3>Could not load positions</h3>
      <p>The testnet RPC or the lens contract did not answer. Nothing was changed.</p>
      <code className="err-detail">{message}</code>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
