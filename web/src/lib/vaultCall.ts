type Address = `0x${string}`;
type Hex = `0x${string}`;

export type ActionKind = "add" | "withdraw" | "borrow" | "repay" | "refinance" | "close" | "claim" | "sweep";

export interface Hints {
  upper: Address;
  lower: Address;
}

export interface PermitSig {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

export interface CallInput {
  kind: ActionKind;
  amount?: bigint;
  hints?: Hints;
  maxFee?: bigint;
  /** Present when the repayment is authorised by a signature instead of an allowance. */
  permit?: PermitSig;
  /** Zero address sweeps BTC. */
  token?: Address;
}

export interface VaultCall {
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
};

/** The vault call for an action. Throws if something the action needs was not supplied. */
export function vaultCall(i: CallInput): VaultCall {
  switch (i.kind) {
    case "add": {
      const h = need(i.hints, "hints");
      return { functionName: "addCollateral", args: [h.upper, h.lower], value: need(i.amount, "amount") };
    }
    case "withdraw": {
      const h = need(i.hints, "hints");
      return { functionName: "withdrawCollateral", args: [need(i.amount, "amount"), h.upper, h.lower] };
    }
    case "borrow": {
      const h = need(i.hints, "hints");
      return { functionName: "borrow", args: [need(i.amount, "amount"), h.upper, h.lower, need(i.maxFee, "maxFee")] };
    }
    case "repay": {
      const h = need(i.hints, "hints");
      const amount = need(i.amount, "amount");
      if (i.permit) {
        const p = i.permit;
        return { functionName: "repayWithPermit", args: [amount, h.upper, h.lower, p.deadline, p.v, p.r, p.s] };
      }
      return { functionName: "repay", args: [amount, h.upper, h.lower] };
    }
    case "refinance": {
      const h = need(i.hints, "hints");
      // minRateDropBps 1 is the contract's own floor, the plan has already required a drop
      return { functionName: "refinance", args: [h.upper, h.lower, need(i.maxFee, "maxFee"), 1] };
    }
    case "close":
      // closeWithPermit is deliberately not used: see lib/manage.ts closeAllowance
      return { functionName: "close", args: [] };
    case "claim":
      return { functionName: "claimSurplus", args: [] };
    case "sweep":
      return { functionName: "sweep", args: [need(i.token, "token")] };
  }
}

/** Which actions move the trove in Mezo's sorted list, so need a hint lookup at the confirm step. */
export const needsHints = (k: ActionKind) => k === "add" || k === "withdraw" || k === "borrow" || k === "repay" || k === "refinance";

/** Which actions pull MUSD from the wallet into the vault. */
export const pullsMusd = (k: ActionKind) => k === "repay" || k === "close";
