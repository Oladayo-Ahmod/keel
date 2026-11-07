import { readFileSync, writeFileSync } from "node:fs";

/** What a run remembers for the next one: how far it read, and when it last told someone about each alert. */
export interface State {
  version: 1;
  lastBlock?: string;
  /** alert key -> unix seconds it was last sent */
  sent: Record<string, number>;
}

export const emptyState = (): State => ({ version: 1, sent: {} });

export function loadState(path: string | undefined): State {
  if (!path) return emptyState();
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    if (s.version !== 1 || typeof s.sent !== "object" || s.sent === null) return emptyState();
    return { version: 1, lastBlock: typeof s.lastBlock === "string" && /^\d+$/.test(s.lastBlock) ? s.lastBlock : undefined, sent: s.sent as Record<string, number> };
  } catch {
    // no file yet, or a corrupt one: start clean rather than refuse to run
    return emptyState();
  }
}

export function saveState(path: string | undefined, s: State): void {
  if (path) writeFileSync(path, JSON.stringify(s, null, 2));
}

/** Drops a near-floor alert that was sent inside the cooldown. Keeper actions are one-off events and always pass. */
export function isCoolingDown(s: State, key: string, now: number, cooldownSeconds: number): boolean {
  if (!key.startsWith("near-floor:")) return false;
  const at = s.sent[key];
  return at !== undefined && now - at < cooldownSeconds;
}
