import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { erc20Abi } from "@/abi/mezo";
import { positionFactoryAbi, positionNFTAbi, positionVaultAbi } from "@/abi/keel";
import { trozuFactoryAbi, trozuMarketAbi, trozuNFTAbi, trozuVaultAbi } from "@/abi/trozu";
import { CAP, FLOOR_SIMPLE, FLOOR_SORTED, GAS_RULES, gasLimitFor, withGas } from "./gas";
import { vaultCall, type ActionKind, type Hints } from "./vaultCall";

const hints: Hints = { upper: "0x0000000000000000000000000000000000000000", lower: "0x0000000000000000000000000000000000000000" };

/** Functions the app never sends, so they need no limit. Anything else that writes must have a rule. */
const NOT_SENT_BY_APP = new Set([
  // set up by the factory, not by a person
  "initializeAndOpen", "mint",
  // the vault's raw trove calls; the app goes through openPosition and the named actions
  "open", "adjust",
  // the keeper's call, not the app's
  "execute",
]);

const ALL_ABIS = { trozuVaultAbi, trozuMarketAbi, trozuFactoryAbi, trozuNFTAbi, positionVaultAbi, positionNFTAbi, positionFactoryAbi, erc20Abi };

function writes(abi: readonly { type: string; name?: string; stateMutability?: string }[]): string[] {
  return abi.filter((x) => x.type === "function" && x.stateMutability !== "view" && x.stateMutability !== "pure").map((x) => x.name!);
}

describe("gas limits", () => {
  it("every state-changing function in the app's contracts has a rule, or is listed as never sent", () => {
    const missing: string[] = [];
    for (const [name, abi] of Object.entries(ALL_ABIS)) {
      for (const fn of writes(abi as never)) {
        if (!(fn in GAS_RULES) && !NOT_SENT_BY_APP.has(fn)) missing.push(`${name}.${fn}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the never-sent list only names functions that exist, so it cannot hide a typo", () => {
    const all = new Set(Object.values(ALL_ABIS).flatMap((abi) => writes(abi as never)));
    expect([...NOT_SENT_BY_APP].filter((f) => !all.has(f))).toEqual([]);
  });

  it("every action the manage panel can build has a rule", () => {
    const kinds: ActionKind[] = ["add", "withdraw", "borrow", "repay", "refinance", "close", "claim", "sweep"];
    for (const kind of kinds) {
      const call = vaultCall({ kind, amount: 1n, hints, maxFee: 1n, token: hints.upper });
      expect(() => gasLimitFor(call.functionName), kind).not.toThrow();
    }
    const permit = vaultCall({ kind: "repay", amount: 1n, hints, permit: { deadline: 1n, v: 27, r: "0x00", s: "0x00" } });
    expect(permit.functionName).toBe("repayWithPermit");
    expect(() => gasLimitFor(permit.functionName)).not.toThrow();
  });

  it("refuses a function that has no rule, so a new write cannot go out with the node's estimate", () => {
    expect(() => gasLimitFor("somethingNew")).toThrow(/no gas limit defined/);
    expect(() => withGas({ functionName: "somethingNew" })).toThrow();
  });

  it("measured gas gets 30% headroom, never less than the floor, never more than the cap", () => {
    for (const [fn, rule] of Object.entries(GAS_RULES)) {
      const limit = gasLimitFor(fn);
      expect(limit, fn).toBeGreaterThanOrEqual(rule.floor);
      expect(limit, fn).toBeLessThanOrEqual(CAP);
      if (rule.measured !== null) expect(limit, fn).toBeGreaterThanOrEqual(Math.min(CAP, Math.ceil(rule.measured * 1.3)));
    }
    // setPolicy with a defense walk measured 3,000,000 on chain
    expect(gasLimitFor("setPolicy")).toBe(3_900_000);
    expect(gasLimitFor("buy")).toBe(1_500_000);
  });

  it("calls that touch the sorted list start from the keeper's 6M floor, the rest from 1M", () => {
    for (const fn of ["openPosition", "addCollateral", "withdrawCollateral", "borrow", "repay", "repayWithPermit", "refinance", "close", "closeWithPermit"]) {
      expect(gasLimitFor(fn), fn).toBeGreaterThanOrEqual(FLOOR_SORTED);
    }
    for (const fn of ["announce", "cancel", "approve", "safeTransferFrom", "claimSurplus", "sweep"]) {
      expect(GAS_RULES[fn].floor, fn).toBe(FLOOR_SIMPLE);
    }
  });

  it("withGas sets the limit as a bigint and replaces any other value", () => {
    expect(withGas({ functionName: "cancel" }).gas).toBe(1_000_000n);
    expect(withGas({ functionName: "cancel", gas: 21_000n }).gas).toBe(1_000_000n);
  });
});

/** Every write in the app must go through useTx, and useTx must pass the limit. */
describe("write call sites", () => {
  const root = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)) files.push(p);
    }
  };
  walk(root);

  it("only useTx calls writeContract, so no write bypasses the limit", () => {
    const offenders = files.filter((f) => /writeContract(Async)?\s*\(|sendTransaction(Async)?\s*\(/.test(readFileSync(f, "utf8")) && !f.endsWith(join("hooks", "useTx.ts")));
    expect(offenders).toEqual([]);
  });

  it("useTx wraps its parameters in withGas", () => {
    const src = readFileSync(join(root, "hooks", "useTx.ts"), "utf8");
    expect(src).toMatch(/writeContractAsync\(\s*withGas\(/);
  });
});
