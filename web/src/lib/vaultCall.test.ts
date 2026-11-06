import { describe, expect, it } from "vitest";
import { positionVaultAbi } from "@/abi/keel";
import { needsHints, pullsMusd, vaultCall } from "./vaultCall";

const hints = { upper: "0x0000000000000000000000000000000000000001", lower: "0x0000000000000000000000000000000000000002" } as const;
const names = new Set(positionVaultAbi.filter((x) => x.type === "function").map((x) => x.name));

describe("vault calls", () => {
  it("add sends the amount as value and only the hints as arguments", () => {
    expect(vaultCall({ kind: "add", amount: 5n, hints })).toEqual({ functionName: "addCollateral", args: [hints.upper, hints.lower], value: 5n });
  });
  it("withdraw and borrow carry the amount, borrow also a fee cap", () => {
    expect(vaultCall({ kind: "withdraw", amount: 5n, hints }).args).toEqual([5n, hints.upper, hints.lower]);
    expect(vaultCall({ kind: "borrow", amount: 5n, hints, maxFee: 9n }).args).toEqual([5n, hints.upper, hints.lower, 9n]);
  });
  it("repay uses the permit variant only with a signature", () => {
    expect(vaultCall({ kind: "repay", amount: 5n, hints }).functionName).toBe("repay");
    const c = vaultCall({ kind: "repay", amount: 5n, hints, permit: { deadline: 7n, v: 27, r: "0x01", s: "0x02" } });
    expect(c.functionName).toBe("repayWithPermit");
    expect(c.args).toEqual([5n, hints.upper, hints.lower, 7n, 27, "0x01", "0x02"]);
  });
  it("refinance always demands a drop of at least one basis point", () => {
    expect(vaultCall({ kind: "refinance", hints, maxFee: 3n }).args).toEqual([hints.upper, hints.lower, 3n, 1]);
  });
  it("close never uses the permit variant", () => {
    expect(vaultCall({ kind: "close" }).functionName).toBe("close");
  });
  it("sweep names the token and claim has no arguments", () => {
    expect(vaultCall({ kind: "sweep", token: hints.upper }).args).toEqual([hints.upper]);
    expect(vaultCall({ kind: "claim" }).args).toEqual([]);
  });
  it("refuses to build a call with a missing piece", () => {
    expect(() => vaultCall({ kind: "withdraw", amount: 1n })).toThrow(/hints/);
    expect(() => vaultCall({ kind: "borrow", amount: 1n, hints })).toThrow(/maxFee/);
  });
  it("every function it names exists in the vault ABI with the same argument count", () => {
    const calls = [
      vaultCall({ kind: "add", amount: 1n, hints }),
      vaultCall({ kind: "withdraw", amount: 1n, hints }),
      vaultCall({ kind: "borrow", amount: 1n, hints, maxFee: 1n }),
      vaultCall({ kind: "repay", amount: 1n, hints }),
      vaultCall({ kind: "repay", amount: 1n, hints, permit: { deadline: 1n, v: 27, r: "0x01", s: "0x02" } }),
      vaultCall({ kind: "refinance", hints, maxFee: 1n }),
      vaultCall({ kind: "close" }),
      vaultCall({ kind: "claim" }),
      vaultCall({ kind: "sweep", token: hints.upper }),
    ];
    for (const c of calls) {
      expect(names.has(c.functionName as never)).toBe(true);
      const abi = positionVaultAbi.find((x) => x.type === "function" && x.name === c.functionName)!;
      expect(c.args.length).toBe((abi as unknown as { inputs: unknown[] }).inputs.length);
    }
  });
  it("classifies which actions need hints and which pull MUSD", () => {
    expect(needsHints("close")).toBe(false);
    expect(needsHints("refinance")).toBe(true);
    expect(pullsMusd("repay") && pullsMusd("close") && !pullsMusd("borrow")).toBe(true);
  });
});
