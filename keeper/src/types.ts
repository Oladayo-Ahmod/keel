export type Hex = `0x${string}`;

/// Mirrors TrozuVault.Kind and TrozuVault.Reason, in contract order.
export const Kind = { None: 0, TopUpBtc: 1, RepayMusd: 2, DefendBtc: 3 } as const;
export const KIND_NAMES = ["None", "TopUpBtc", "RepayMusd", "DefendBtc"] as const;
export const REASON_NAMES = [
  "None",
  "NoPolicy",
  "PolicyStale",
  "TroveInactive",
  "NoPrice",
  "Healthy",
  "BufferUnknown",
  "NoReserve",
  "BelowMinimum",
] as const;

/// What the vault's own planner says `execute` would do. The keeper never re-derives this.
export interface Plan {
  kind: number;
  reason: number;
  amount: bigint;
  tip: bigint;
  icr: bigint;
  resetWindow: boolean;
}

/// A call that reached the chain and was refused by the contract. Not retried.
export class ChainRevert extends Error {
  constructor(public reason: string) {
    super(`reverted: ${reason}`);
    this.name = "ChainRevert";
  }
}

export interface SendResult {
  hash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
}

/// Everything the keeper needs from the chain. The real one is viem; tests mock it.
export interface ChainApi {
  head(): Promise<bigint>;
  /// Vaults created by the factory in the window.
  createdVaults(from: bigint, to: bigint): Promise<Hex[]>;
  /// Addresses that emitted PolicySet in the window. Anyone can emit that topic, so the keeper
  /// only trusts the ones that are also factory-created vaults.
  policyEmitters(from: bigint, to: bigint): Promise<Hex[]>;
  policyLive(vault: Hex): Promise<boolean>;
  preview(vault: Hex): Promise<Plan>;
  /// Sorted-list hints for the position's new ratio after the planned action. Mezo only uses them as
  /// a starting point, so a wrong pair costs gas and never reverts; no hints means a walk from the
  /// head of the list (about 4.5M gas against about 0.6M with a good hint, measured in Wave 1).
  hints?(vault: Hex, plan: Plan): Promise<readonly [Hex, Hex]>;
  /// Throws ChainRevert if the call would revert.
  estimateExecute(vault: Hex, hints?: readonly [Hex, Hex]): Promise<bigint>;
  sendExecute(vault: Hex, gas: bigint, hints?: readonly [Hex, Hex]): Promise<SendResult>;
}
