import { createPublicClient, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex, type Hex, type PublicClient, type StateOverride } from "viem";
import { describe, expect, it } from "vitest";
import { createTrozu, feeOn, MARKET_STATES, matsnet, nicrOf, type Bounds, type ListingView, type UnsignedTx } from "../src/index.js";
import { marketAbi } from "../src/generated/abis.js";

/**
 * Read-only checks against the live Mezo testnet. Nothing is sent and no key is used. They are off by
 * default because the public RPC is shared and flaky; run them with `npm run test:matsnet`.
 *
 * Position 1 and its vault are the ones the proof run used (docs/proof.json). The values that move
 * (ratio, reserve, holder) are only checked for shape, never for a number.
 */
const on = process.env.MATSNET === "1";
const PROOF_VAULT = "0x2B08BB7F73beD0FA0454907a7E7082F1a58d9AB9";

describe.skipIf(!on)("matsnet (read only)", () => {
  const client = createPublicClient({ transport: http(matsnet.rpcUrl, { retryCount: 5, retryDelay: 400, timeout: 20_000 }) }) as PublicClient;
  const trozu = createTrozu({ client });

  it("is the chain the deployment record says it is", async () => {
    expect(await client.getChainId()).toBe(matsnet.chainId);
  });

  it("reads position 1 through the Lens", async () => {
    const p = await trozu.lens.position(1n);
    expect(p.vault).toBe(PROOF_VAULT);
    expect(p.tokenId).toBe(1n);
    expect(p.holder).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(["none", "safe", "caution", "danger", "liquidatable"]).toContain(p.risk);
    expect(p.collateral).toBeGreaterThanOrEqual(0n);
    expect(p.lockedRateBps).toBeGreaterThanOrEqual(0);
    expect(p.marketRateBps).toBeGreaterThan(0);
    expect(await trozu.vaultOf(1n)).toBe(PROOF_VAULT);
  }, 60_000);

  it("lists the positions of its holder", async () => {
    const p = await trozu.lens.position(1n);
    expect(await trozu.lens.positionsOf(p.holder)).toContain(1n);
  }, 60_000);

  it("reads the redemption buffer and a verdict", async () => {
    const b = await trozu.lens.bufferCheck(1n, 1n, 100);
    expect(["unknown", "above", "below"]).toContain(b.verdict);
    expect(b.steps).toBeLessThanOrEqual(100n);
  }, 60_000);

  it("reads the guardian's status and policy", async () => {
    const g = await trozu.guardian.status(1n);
    expect(g.vault).toBe(PROOF_VAULT);
    expect(g.policy.period).toBeGreaterThanOrEqual(0);
    expect(g.allowance.btc).toBeLessThanOrEqual(g.policy.periodCapBtc);
    expect(typeof g.live).toBe("boolean");
  }, 60_000);

  it("scans announced listings in real log windows and gets a known state for each", async () => {
    // the staged listings were announced a day or so before the end of the proof run
    const out = await trozu.market.listings({ lookbackBlocks: 40_000, limit: 20 });
    for (const l of out) {
      expect(MARKET_STATES).toContain(l.state);
      expect(l.hash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  }, 120_000);

  it("computes the same fee the market contract does", async () => {
    const price = 123_456_789_012_345_678_901n;
    const onChain = await client.readContract({ address: matsnet.trozu.market, abi: marketAbi, functionName: "feeOn", args: [price] });
    expect(feeOn(price, matsnet.market.feeBps)).toBe(onChain);
  }, 60_000);

  it("simulates the guardian's execute for a stranger and gets an answer the SDK understands", async () => {
    const tx = trozu.tx.execute({ vault: PROOF_VAULT });
    const r = await trozu.simulate(tx, "0x00000000000000000000000000000000000000a1");
    // either it would run, or it reverts with a typed reason; a network or unknown failure is a bug here
    if (!r.ok) expect(r.error.code).toBe("REVERT");
  }, 60_000);

  it("gets sorted-list hints from Mezo for a plausible ratio", async () => {
    const p = await trozu.lens.position(1n);
    const nicr = nicrOf(p.collateral, p.principal) ?? 10n ** 20n;
    const [upper, lower] = await trozu.hints(nicr, 1n);
    expect(upper).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(lower).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 60_000);
});

/**
 * Simulations of the money-moving builders with eth_call only: nothing is signed or sent, so no key is
 * involved. They use the real staged position (id 1, held by the deployer) and its live listings, and the
 * addresses of the two test wallets (public, from docs/proof.json).
 *
 * Several of these depend on live state (a position that falls under its floor makes the guardian act, a
 * cancelled staged listing leaves nothing to buy), so a failure here can mean the staging changed and not
 * that a builder broke. docs/INTEGRATIONS.md records the results of the run on 2026-11-07.
 */
const SECOND = "0xf8B5CF0292C4e5202CC9a9e6041FD59F692edEe2" as const;
const STRANGER = "0x00000000000000000000000000000000000000a1" as const;
const E = 10n ** 18n;

const word = (n: bigint): Hex => pad(toHex(n), { size: 32 });
// MUSD is an OpenZeppelin ERC20: _balances is storage slot 0 and _allowances slot 1 (checked below)
const balanceSlot = (owner: Hex): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 0n]));
const allowanceSlot = (owner: Hex, spender: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 1n]))]));
/** Pretend `owner` holds `amount` MUSD and has approved `spender` for it, for one eth_call. */
const withMusd = (owner: Hex, spender: Hex, amount: bigint): StateOverride => [
  { address: matsnet.mezo.musd, stateDiff: [{ slot: balanceSlot(owner), value: word(amount) }, { slot: allowanceSlot(owner, spender), value: word(amount) }] },
];

describe.skipIf(!on)("simulated on matsnet with eth_call only", () => {
  const client = createPublicClient({ transport: http(matsnet.rpcUrl, { retryCount: 5, retryDelay: 400, timeout: 20_000 }) }) as PublicClient;
  const trozu = createTrozu({ client });
  const musdAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

  let vault: Hex;
  let holder: Hex;
  let fixed: ListingView;
  let bounds: Bounds;

  const run = async (tx: UnsignedTx, from: string, override?: StateOverride) => trozu.simulate(tx, from, { stateOverride: override });
  const nameOf = (e: unknown) => (e as { errorName?: string }).errorName;
  const expectOk = async (tx: UnsignedTx, from: string, override?: StateOverride) => {
    const r = await run(tx, from, override);
    if (!r.ok) throw new Error(`${tx.functionName} as ${from} reverted: ${nameOf(r.error) ?? r.error.code}: ${r.error.message}`);
  };
  const expectRevert = async (tx: UnsignedTx, from: string, names: string[], override?: StateOverride) => {
    const r = await run(tx, from, override);
    expect(r.ok, `${tx.functionName} should have reverted`).toBe(false);
    if (!r.ok) expect(names, `${tx.functionName} reverted with ${nameOf(r.error) ?? r.error.code}: ${r.error.message}`).toContain(nameOf(r.error));
  };

  it("finds the staged position and its open fixed-price listing", async () => {
    vault = await trozu.vaultOf(1n);
    holder = (await trozu.lens.position(1n)).holder;
    const open = await trozu.market.listings({ tokenId: 1n, onlyOpen: true, lookbackBlocks: 60_000 });
    const f = open.find((l) => !l.dutch);
    expect(f, "no open fixed listing for position 1: the staging changed").toBeDefined();
    fixed = f!;
    const q = await trozu.market.quote(fixed.listing, fixed.signature);
    expect(q.bounds).toBeDefined();
    bounds = q.bounds!;
  }, 120_000);

  it("has MUSD storage where the override helper assumes it is", async () => {
    const v = 123_456n * E;
    const o = withMusd(SECOND, matsnet.trozu.market, v);
    expect(await client.readContract({ address: matsnet.mezo.musd, abi: musdAbi, functionName: "balanceOf", args: [SECOND], stateOverride: o })).toBe(v);
    expect(await client.readContract({ address: matsnet.mezo.musd, abi: musdAbi, functionName: "allowance", args: [SECOND, matsnet.trozu.market], stateOverride: o })).toBe(v);
  }, 60_000);

  // ---- buy: the staged fixed listing, as the second wallet -------------------------------------------------

  it("buy as the second wallet reverts on MUSD, not on the calldata: it holds less than the price and has approved nothing", async () => {
    const tx = trozu.tx.buy({ listing: fixed.listing, signature: fixed.signature, bounds, recipient: SECOND });
    await expectRevert(tx, SECOND, ["ERC20InsufficientAllowance", "ERC20InsufficientBalance"]);
  }, 60_000);

  it("buy as the second wallet succeeds once it is given MUSD and an allowance (override)", async () => {
    const tx = trozu.tx.buy({ listing: fixed.listing, signature: fixed.signature, bounds, recipient: SECOND });
    await expectOk(tx, SECOND, withMusd(SECOND, matsnet.trozu.market, fixed.priceNow! * 2n));
  }, 60_000);

  it("buy is refused by its own bounds, with typed errors, before any MUSD moves", async () => {
    const b = (over: Partial<Bounds>) => trozu.tx.buy({ listing: fixed.listing, signature: fixed.signature, bounds: { ...bounds, ...over }, recipient: SECOND });
    await expectRevert(b({ maxPrice: 1n }), SECOND, ["PriceAboveMax"]);
    await expectRevert(b({ expectedEpoch: bounds.expectedEpoch + 1n }), SECOND, ["EpochMismatch"]);
    await expectRevert(b({ minColl: bounds.minColl * 2n }), SECOND, ["CollateralBelowMin"]);
    await expectRevert(b({ maxDebt: 1n }), SECOND, ["DebtAboveMax"]);
    await expectRevert(b({ minReserveBtc: bounds.minReserveBtc * 2n + 1n }), SECOND, ["ReserveBelowMin"]);
  }, 120_000);

  // ---- cancel and add collateral: as the holder, and as someone else ----------------------------------------

  it("cancel works for the seller and is refused for anyone else", async () => {
    const tx = trozu.tx.cancel({ listing: fixed.listing });
    await expectOk(tx, holder);
    await expectRevert(tx, SECOND, ["NotSeller"]);
  }, 60_000);

  it("add collateral works for the holder and is refused for anyone else", async () => {
    const tx = trozu.tx.addCollateral({ vault, amount: E / 2000n });
    await expectOk(tx, holder);
    await expectRevert(tx, SECOND, ["NotHolder"]);
  }, 60_000);

  // ---- the guardian, as a stranger ---------------------------------------------------------------------------

  it("execute as a stranger either runs or says there is nothing to do, at the gas the builder sets", async () => {
    const g = await trozu.guardian.status(1n);
    const tx = trozu.tx.execute({ vault, gas: { defenseWalk: g.policy.bufferFloorMusd > 0n } });
    const r = await run(tx, STRANGER);
    // healthy position: NothingToDo. If the ratio has since fallen under the floor, it would succeed instead.
    if (!r.ok) expect(nameOf(r.error)).toBe("NothingToDo");
  }, 60_000);

  // ---- every other builder, as the holder ---------------------------------------------------------------------

  const musdVault = () => withMusd(holder, vault, 10_000n * E);
  const cases: [string, () => UnsignedTx, "ok" | string[], (() => StateOverride) | undefined][] = [
    ["withdrawCollateral", () => trozu.tx.withdrawCollateral({ vault, amount: E / 10_000n }), "ok", undefined],
    ["borrow", () => trozu.tx.borrow({ vault, amount: E, maxFee: 5n * E }), "ok", undefined],
    ["repay (with allowance)", () => trozu.tx.repay({ vault, amount: E }), "ok", musdVault],
    ["repay (no allowance)", () => trozu.tx.repay({ vault, amount: E }), ["ERC20InsufficientAllowance"], undefined],
    ["refinance", () => trozu.tx.refinance({ vault, maxFee: 5n * E }), ["NoRateImprovement"], undefined],
    ["close (with allowance)", () => trozu.tx.close({ vault }), "ok", musdVault],
    ["close (no allowance)", () => trozu.tx.close({ vault }), ["ERC20InsufficientAllowance"], undefined],
    ["claimSurplus", () => trozu.tx.claimSurplus({ vault }), ["MezoRefusal"], undefined],
    ["fundReserveBtc", () => trozu.tx.fundReserveBtc({ vault, amount: E / 10_000n }), "ok", undefined],
    ["fundReserveMusd (with allowance)", () => trozu.tx.fundReserveMusd({ vault, amount: E }), "ok", musdVault],
    ["fundReserveMusd (no allowance)", () => trozu.tx.fundReserveMusd({ vault, amount: E }), ["ERC20InsufficientAllowance"], undefined],
    ["withdrawReserveBtc", () => trozu.tx.withdrawReserveBtc({ vault, amount: E / 10_000n }), "ok", undefined],
    ["withdrawReserveMusd (reserve is empty)", () => trozu.tx.withdrawReserveMusd({ vault, amount: E }), ["ReserveTooSmall"], undefined],
    ["clearPolicy", () => trozu.tx.clearPolicy({ vault }), "ok", undefined],
    ["sweep", () => trozu.tx.sweep({ vault, token: matsnet.mezo.musd }), "ok", undefined],
    ["approveMarketFor", () => trozu.tx.approveMarketFor({ tokenId: 1n }), "ok", undefined],
    ["approveMusd", () => trozu.tx.approveMusd({ spender: matsnet.trozu.market, amount: 10n * E }), "ok", undefined],
    ["transferPosition", () => trozu.tx.transferPosition({ from: holder, to: SECOND, tokenId: 1n }), "ok", undefined],
    ["cancelAll", () => trozu.tx.cancelAll(), "ok", undefined],
    ["announce (the live listing again)", () => trozu.tx.announce({ listing: fixed.listing, signature: fixed.signature }), "ok", undefined],
    ["openPosition below the minimum debt", () => trozu.tx.openPosition({ debt: 10n * E, collateral: E / 1000n, maxFee: E }), ["MezoRefusal"], undefined],
  ];

  it.each(cases)("%s", async (_name, build, expected, override) => {
    if (expected === "ok") await expectOk(build(), holder, override?.());
    else await expectRevert(build(), holder, expected, override?.());
  }, 60_000);

  it("setPolicy with the policy that is already live", async () => {
    const g = await trozu.guardian.status(1n);
    const { epoch: _e, active: _a, ...policy } = g.policy;
    await expectOk(trozu.tx.setPolicy({ vault, policy }), holder);
  }, 60_000);
});
