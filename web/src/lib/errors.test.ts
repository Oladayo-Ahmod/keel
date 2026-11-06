import { describe, expect, it } from "vitest";
import { friendlyError } from "./errors";

const withCause = (msg: string) => Object.assign(new Error("outer"), { shortMessage: msg, cause: { shortMessage: msg } });

describe("friendlyError", () => {
  it("recognises a declined wallet request and says nothing was sent", () => {
    const r = friendlyError(Object.assign(new Error("x"), { code: 4001 }));
    expect(r.rejected).toBe(true);
    expect(r.message).toMatch(/Nothing was sent/);
  });
  it("explains the vault's refinance errors", () => {
    expect(friendlyError(withCause("reverted: NoRateImprovement(100, 100)")).message).toMatch(/no longer below/);
    expect(friendlyError(withCause("reverted: RefinanceFeeTooHigh(5, 4)")).message).toMatch(/refinancing fee/);
    expect(friendlyError(withCause("reverted: RefinanceFeeTooHigh(5, 4)")).message).not.toMatch(/borrowing/);
  });
  it("explains the debt cap and the fee limit", () => {
    expect(friendlyError(withCause("DebtCapExceeded(1, 0)")).message).toMatch(/caps how much/);
    expect(friendlyError(withCause("FeeTooHigh(2, 1)")).message).toMatch(/borrowing fee rose/);
  });
  it("falls back to the first line, cut to a sensible length", () => {
    const r = friendlyError(withCause("x".repeat(500)));
    expect(r.message.length).toBeLessThanOrEqual(220);
    expect(r.rejected).toBe(false);
  });
});
