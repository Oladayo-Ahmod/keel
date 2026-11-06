import { describe, expect, it } from "vitest";
import {
  approvalFor,
  closeAllowance,
  icrOf,
  maxRepay,
  maxWithdraw,
  planAddCollateral,
  planBorrow,
  planClaim,
  planClose,
  planRefinance,
  planRepay,
  planSweep,
  planWithdraw,
  type Snapshot,
  type Wallet,
} from "./manage";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

// 0.05 BTC at 60,000 is 3,000 USD against 1,800 debt: 166.7%
const snap: Snapshot = {
  active: true,
  priceOk: true,
  price: e18(60_000),
  coll: e18(0.05),
  principal: e18(1_790),
  interest: e18(10),
  recoveryMode: false,
  canClose: true,
  lockedRateBps: 100,
  globalRateBps: 50,
  refinanceFeeEstimate: e18(1),
  claimableSurplus: 0n,
};
const wallet: Wallet = { btc: e18(1), musd: e18(5_000), allowance: 0n, minNetDebt: e18(1_800) };

describe("icr", () => {
  it("is collateral value over total debt", () => {
    expect(icrOf(snap.coll, e18(1_800), snap.price)).toBe((e18(3_000) * 10n ** 18n) / e18(1_800));
  });
  it("is undefined with no debt or no price", () => {
    expect(icrOf(1n, 0n, 1n)).toBeUndefined();
    expect(icrOf(1n, 1n, 0n)).toBeUndefined();
  });
});

describe("add collateral", () => {
  it("raises the ratio", () => {
    const p = planAddCollateral(snap, e18(0.01), wallet);
    expect(p.errors).toEqual([]);
    expect(p.newIcr! > icrOf(snap.coll, e18(1_800), snap.price)!).toBe(true);
  });
  it("needs gas money left over", () => {
    const p = planAddCollateral(snap, e18(0.999), wallet);
    expect(p.errors.join()).toMatch(/Not enough BTC/);
  });
  it("blocks while the balance is unknown", () => {
    expect(planAddCollateral(snap, e18(0.01), { ...wallet, btc: undefined }).errors.length).toBe(1);
  });
  it("works without a price, since a top up cannot hurt the ratio", () => {
    expect(planAddCollateral({ ...snap, priceOk: false, price: 0n }, e18(0.01), wallet).errors).toEqual([]);
  });
});

describe("withdraw", () => {
  it("allows a withdrawal that stays above 150%", () => {
    const p = planWithdraw(snap, e18(0.002));
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
  });
  it("warns between 120% and 150%", () => {
    // 0.0425 BTC is 2,550 USD, 141.7%
    const p = planWithdraw(snap, e18(0.0075));
    expect(p.errors).toEqual([]);
    expect(p.warnings.length).toBe(1);
  });
  it("refuses under 120%, and under 110% says why", () => {
    expect(planWithdraw(snap, e18(0.016)).errors.join()).toMatch(/under 120%/);
    expect(planWithdraw(snap, e18(0.025)).errors.join()).toMatch(/under 110%/);
  });
  it("refuses more than the position holds, and emptying it", () => {
    expect(planWithdraw(snap, e18(1)).errors.join()).toMatch(/more collateral/);
    expect(planWithdraw(snap, snap.coll).errors.join()).toMatch(/Close the position/);
  });
  it("is blocked in recovery mode", () => {
    expect(planWithdraw({ ...snap, recoveryMode: true }, e18(0.001)).errors.join()).toMatch(/Recovery Mode/);
  });
  it("is blocked with no price", () => {
    expect(planWithdraw({ ...snap, priceOk: false, price: 0n }, e18(0.001)).errors.join()).toMatch(/price feed/);
  });
  it("maxWithdraw keeps the target ratio and never rounds past it", () => {
    const target = 15n * 10n ** 17n;
    const m = maxWithdraw(snap, target);
    const after = icrOf(snap.coll - m, 1_800n * 10n ** 18n, snap.price)!;
    expect(after >= target).toBe(true);
    const over = icrOf(snap.coll - m - 1n * 10n ** 12n, 1_800n * 10n ** 18n, snap.price)!;
    expect(over < target).toBe(true);
  });
  it("maxWithdraw is zero when already under the target", () => {
    expect(maxWithdraw({ ...snap, coll: e18(0.03) }, 15n * 10n ** 17n)).toBe(0n);
  });
});

describe("borrow", () => {
  it("includes the fee in the new debt", () => {
    const p = planBorrow(snap, e18(100), e18(1));
    expect(p.newDebt).toBe(e18(1_800) + e18(101));
  });
  it("waits for the fee", () => {
    expect(planBorrow(snap, e18(100), undefined).errors.length).toBe(1);
  });
  it("refuses a borrow that ends under 120%", () => {
    expect(planBorrow(snap, e18(700), e18(3)).errors.join()).toMatch(/under 120%/);
  });
  it("needs 150% in recovery mode", () => {
    const p = planBorrow({ ...snap, recoveryMode: true }, e18(400), e18(2));
    expect(p.errors.join()).toMatch(/Recovery Mode/);
  });
});

describe("repay", () => {
  it("caps the repayment so net debt stays at Mezo's minimum", () => {
    // debt 1,800 total, net 1,600, below the 1,800 minimum, so nothing can be repaid partly
    expect(maxRepay(snap, e18(1_800))).toBe(0n);
    expect(maxRepay({ ...snap, principal: e18(3_990) }, e18(1_800))).toBe(e18(4_000) - e18(200) - e18(1_800));
  });
  it("explains a position that is at the minimum", () => {
    expect(planRepay(snap, e18(10), wallet).errors.join()).toMatch(/minimum debt/);
  });
  it("accepts a valid repayment and lowers debt", () => {
    const s = { ...snap, principal: e18(3_990), coll: e18(0.1) };
    const p = planRepay(s, e18(500), wallet);
    expect(p.errors).toEqual([]);
    expect(p.newDebt).toBe(e18(3_500));
  });
  it("needs the MUSD in the wallet", () => {
    const s = { ...snap, principal: e18(3_990) };
    expect(planRepay(s, e18(500), { ...wallet, musd: e18(100) }).errors.join()).toMatch(/less than this repayment/);
  });
  it("pays interest before principal when working out the sorted-list key", () => {
    const s = { ...snap, principal: e18(3_990), interest: e18(10) };
    const small = planRepay(s, e18(5), wallet);
    expect(small.hintNicr).toBe((s.coll * 10n ** 20n) / s.principal);
  });
});

describe("approval choice", () => {
  it("uses an existing allowance first", () => {
    expect(approvalFor(10n, 10n, true)).toBe("allowance");
  });
  it("prefers a permit, falls back to an approve transaction", () => {
    expect(approvalFor(10n, 5n, true)).toBe("permit");
    expect(approvalFor(10n, 5n, false)).toBe("approve");
    expect(approvalFor(10n, undefined, true)).toBe("permit");
  });
});

describe("refinance", () => {
  // locked 1.00% against a market 0.50%: a 50 bp drop on 1,790 principal is 8.95 MUSD a year
  it("shows the drop, fee and break-even", () => {
    const p = planRefinance(snap);
    expect(p.errors).toEqual([]);
    expect(p.dropBps).toBe(50);
    expect(p.yearlySaving).toBe(e18(8.95));
    expect(p.breakEvenDays).toBe(40.78); // 1 MUSD fee at 8.95 a year, truncated
    expect(p.maxFee).toBeGreaterThan(p.fee);
  });
  it("reports a real saving, not zero, whichever way the Lens signs its spread", () => {
    expect(planRefinance(snap).yearlySaving > 0n).toBe(true);
  });
  it("refuses an equal or higher market rate and reports no saving", () => {
    expect(planRefinance({ ...snap, globalRateBps: 100 }).errors.join()).toMatch(/nothing to gain/);
    const up = planRefinance({ ...snap, globalRateBps: 150 });
    expect(up.errors.join()).toMatch(/raise your rate/);
    expect(up.yearlySaving).toBe(0n);
    expect(up.breakEvenDays).toBeUndefined();
  });
  it("is blocked in recovery mode", () => {
    expect(planRefinance({ ...snap, recoveryMode: true }).errors.join()).toMatch(/Recovery Mode/);
  });
});

describe("close", () => {
  it("costs the debt minus the 200 MUSD reserve and returns the collateral", () => {
    const p = planClose(snap, wallet);
    expect(p.errors).toEqual([]);
    expect(p.cost).toBe(e18(1_600));
    expect(p.returned).toBe(snap.coll);
  });
  it("says how short the wallet is", () => {
    const p = planClose(snap, { ...wallet, musd: e18(1_000) });
    expect(p.errors.join()).toMatch(/short by 600.00 MUSD/);
  });
  it("is blocked for the last trove and in recovery mode", () => {
    expect(planClose({ ...snap, canClose: false }, wallet).errors.join()).toMatch(/last trove/);
    expect(planClose({ ...snap, recoveryMode: true }, wallet).errors.join()).toMatch(/Recovery Mode/);
  });
  it("asks for slightly more allowance than the cost, because interest keeps accruing", () => {
    const a = closeAllowance(e18(1_600));
    expect(a > e18(1_600)).toBe(true);
    expect(a < e18(1_602)).toBe(true);
  });
});

describe("claim and sweep", () => {
  it("claim needs a surplus", () => {
    expect(planClaim(snap).errors.length).toBe(1);
    expect(planClaim({ ...snap, claimableSurplus: 1n }).errors).toEqual([]);
  });
  it("sweep needs something to sweep", () => {
    expect(planSweep(0n, 0n).sweepable).toBe(false);
    expect(planSweep(1n, 0n).sweepable).toBe(true);
    expect(planSweep(0n, 1n).sweepable).toBe(true);
  });
});

describe("closed trove", () => {
  it("every trove action is refused when there is none", () => {
    const dead = { ...snap, active: false };
    expect(planAddCollateral(dead, 1n, wallet).errors.join()).toMatch(/no open trove/);
    expect(planWithdraw(dead, 1n).errors.join()).toMatch(/no open trove/);
    expect(planBorrow(dead, 1n, 0n).errors.join()).toMatch(/no open trove/);
    expect(planRepay(dead, 1n, wallet).errors.join()).toMatch(/no open trove/);
    expect(planRefinance(dead).errors.join()).toMatch(/no open trove/);
    expect(planClose(dead, wallet).errors.join()).toMatch(/no open trove/);
  });
});
