import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { marketAbi, vaultAbi } from "@trozu/sdk";
import { ADDR, body, E18, fixture, hashOf } from "./fixture.js";

describe("get_position", () => {
  it("returns the position in plain units with the locked rate against the market rate", async () => {
    const { h } = fixture();
    const r = body(await h.get_position({ tokenId: "7" }));
    expect(r.position).toMatchObject({
      tokenId: "7",
      vault: ADDR.vault,
      risk: "safe",
      collateralBtc: "2",
      debtMusd: "1005",
      equityMusd: "197995",
      icrPercent: 199,
      lockedRatePercent: 4.5,
      marketRatePercent: 3,
      rateAdvantagePoints: -1.5,
    });
  });

  it("gives the redemption buffer verdict and says unknown is not safe", async () => {
    const { h } = fixture();
    const r = body(await h.get_position({ tokenId: 7, bufferThresholdMusd: "50000" }));
    expect(r.redemptionBuffer.verdict).toBe("unknown");
    expect(r.redemptionBuffer.meaning).toMatch(/not proven/i);
    expect(r.redemptionBuffer.complete).toBe(false);
  });

  it("lists what a wallet holds, with detail for a few", async () => {
    const { h } = fixture();
    const r = body(await h.get_position({ holder: ADDR.alice.toLowerCase(), positions: 2 }));
    expect(r.positionIds).toEqual(["3", "7", "9"]);
    expect(r.positionCount).toBe(3);
    expect(r.details).toHaveLength(2);
  });

  it("needs exactly one of tokenId and holder", async () => {
    const { h } = fixture();
    expect((await h.get_position({})).isError).toBe(true);
    expect((await h.get_position({ tokenId: 1, holder: ADDR.alice })).isError).toBe(true);
  });
});

describe("list_listings and quote_listing", () => {
  it("lists open listings with the price now", async () => {
    const { h, announce } = fixture({ states: { "2": 5 } });
    announce(1n, 16_699_000n);
    announce(2n, 16_699_500n);
    const r = body(await h.list_listings({}));
    expect(r.count).toBe(1);
    expect(r.listings[0]).toMatchObject({ hash: hashOf(1n), tokenId: "7", state: "Ok", open: true, kind: "dutch", priceNowMusd: "900" });
    const all = body(await h.list_listings({ onlyOpen: false }));
    expect(all.listings.map((l: { state: string }) => l.state)).toEqual(["Expired", "Ok"]);
  });

  it("quotes a listing with the bounds a careful buyer would sign", async () => {
    const { h, announce } = fixture();
    announce(1n, 16_699_000n);
    const r = body(await h.quote_listing({ tokenId: "7" }));
    expect(r.quote).toMatchObject({ state: "Ok", open: true, priceMusd: "900" });
    expect(r.quote.recommendedBounds).toMatchObject({ expectedEpoch: "4", minCollateralBtc: "2", maxPriceMusd: "900", minRatePercent: 4.5, maxRatePercent: 4.5, minReserveBtc: "3" });
  });

  it("says so when the listing is not there", async () => {
    const { h } = fixture();
    const r = await h.quote_listing({ listingHash: hashOf(99n) });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe("VALIDATION");
  });
});

describe("guardian_status", () => {
  it("reports the policy, the plan, and whether the margin to the floor is inside the alert margin", async () => {
    const { h } = fixture();
    const r = body(await h.guardian_status({ tokenId: "7" }));
    expect(r.policyLive).toBe(true);
    expect(r.policy).toMatchObject({ floorPercent: 130, targetPercent: 160, periodHours: 24 });
    expect(r.plan).toMatchObject({ kind: "None", reason: "Healthy" });
    expect(r.windowResetsAtUnix).not.toBeNull();
    expect(r.marginToFloorPoints).toBe(15);
    expect(r.withinAlertMargin).toBe(false);
    expect(body(await h.guardian_status({ tokenId: "7", marginPoints: 20 })).withinAlertMargin).toBe(true);
  });
});

describe("build_tx", () => {
  it("builds add_collateral against the position's vault, with value and an explicit gas limit", async () => {
    const { h } = fixture();
    const r = body(await h.build_tx({ action: "add_collateral", tokenId: "7", amount: "0.5" }));
    expect(r.unsigned).toBe(true);
    expect(r.tx).toMatchObject({ chainId: 31611, to: ADDR.vault, value: (E18 / 2n).toString(), gas: "6000000", functionName: "addCollateral" });
    expect(r.summary).toContain("Add 0.5 BTC");
    expect(decodeFunctionData({ abi: vaultAbi, data: r.tx.data }).functionName).toBe("addCollateral");
    // nothing in the answer could be a signature, a key or a raw transaction
    expect(Object.keys(r.tx).sort()).toEqual(["chainId", "data", "functionName", "gas", "to", "value"]);
  });

  it("raises the gas limit to the cap when the policy has redemption defense", async () => {
    const { h } = fixture({ bufferFloorMusd: 1000n * E18 });
    const r = body(await h.build_tx({ action: "execute_guardian", tokenId: "7" }));
    expect(r.tx.gas).toBe("9500000");
  });

  it("builds set_policy from percentages and hours, and refuses a bad one with the reasons", async () => {
    const { h } = fixture();
    const good = body(await h.build_tx({ action: "set_policy", tokenId: 7, floorPercent: "130", targetPercent: "160", maxActionBtc: "0.1", periodCapBtc: "0.5", keeperTipBtc: "0.00005", periodHours: 24 }));
    const d = decodeFunctionData({ abi: vaultAbi, data: good.tx.data });
    expect((d.args as unknown as { floorIcr: bigint; period: number }[])[0]).toMatchObject({ floorIcr: 13n * 10n ** 17n, period: 86_400 });
    const bad = await h.build_tx({ action: "set_policy", tokenId: 7, floorPercent: "105", targetPercent: "160", maxActionBtc: "0.1", periodCapBtc: "0.5", periodHours: 24 });
    expect(bad.isError).toBe(true);
    expect(body(bad).error.issues.join()).toMatch(/floorIcr/);
  });

  it("builds a buy from a listing with the bounds worked out, and the recipient", async () => {
    const { h, announce } = fixture();
    announce(1n, 16_699_000n);
    const r = body(await h.build_tx({ action: "buy", tokenId: "7", recipient: ADDR.bob }));
    const d = decodeFunctionData({ abi: marketAbi, data: r.tx.data });
    expect(d.functionName).toBe("buy");
    const args = d.args as unknown as [unknown, unknown, { maxPrice: bigint; minColl: bigint; expectedEpoch: bigint }, string];
    expect(args[2]).toMatchObject({ maxPrice: 900n * E18, minColl: 2n * E18, expectedEpoch: 4n });
    expect(args[3]).toBe(ADDR.bob);
    expect(r.warnings.join(" ")).toMatch(/allowance for the market/);
  });

  it("will not build a buy for a listing that cannot be bought", async () => {
    const { h, announce } = fixture({ states: { "1": 5 } });
    announce(1n, 16_699_000n);
    const r = await h.build_tx({ action: "buy", listingHash: hashOf(1n), recipient: ADDR.bob });
    expect(r.isError).toBe(true);
    expect(body(r).error.issues.join()).toMatch(/expired/);
  });

  it("builds approvals for the market, a vault or an address", async () => {
    const { h, trozu } = fixture();
    expect(body(await h.build_tx({ action: "approve_musd", spender: "market", amount: "10" })).tx.to).toBe(trozu.deployment.mezo.musd);
    expect((await h.build_tx({ action: "approve_musd", spender: "vault", amount: "10" })).isError).toBe(true);
    expect(body(await h.build_tx({ action: "approve_musd", spender: "vault", tokenId: 7, amount: "10" })).summary).toContain("0x3333...3333"); // the cleaner folds the ellipsis to three dots
    expect(body(await h.build_tx({ action: "approve_market", tokenId: 7 })).tx.functionName).toBe("approve");
  });

  it("builds a transfer from the current holder", async () => {
    const { h } = fixture();
    const r = body(await h.build_tx({ action: "transfer_position", tokenId: 7, to: ADDR.bob }));
    expect(r.summary).toContain("0x1111...1111");
    expect(r.warnings.join()).toMatch(/Check the address/);
  });
});

describe("simulate_action", () => {
  it("says a call would succeed, and still returns the unsigned transaction", async () => {
    const { h } = fixture();
    const r = body(await h.simulate_action({ action: "add_collateral", tokenId: 7, amount: "1", from: ADDR.alice }));
    expect(r.wouldSucceed).toBe(true);
    expect(r.tx.functionName).toBe("addCollateral");
    expect(r.caveat).toMatch(/hint/);
  });

  it("explains a revert in our own words", async () => {
    const { h } = fixture({ badPolicyText: "floor too low" });
    const r = body(await h.simulate_action({ action: "set_policy", tokenId: 7, floorPercent: "130", targetPercent: "160", maxActionBtc: "0.1", periodCapBtc: "0.5", periodHours: 24, from: ADDR.alice }));
    expect(r.wouldSucceed).toBe(false);
    expect(r.error).toMatchObject({ code: "REVERT", errorName: "BadPolicy", message: "The vault refused this guardian policy." });
  });

  it("needs a valid sender", async () => {
    const { h } = fixture();
    expect((await h.simulate_action({ action: "close", tokenId: 7, from: "me" })).isError).toBe(true);
  });
});
