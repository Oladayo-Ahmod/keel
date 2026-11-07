import { createPublicClient, http, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { createTrozu, feeOn, MARKET_STATES, matsnet, nicrOf } from "../src/index.js";
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

  it("gets sorted-list hints from Mezo for a plausible ratio", async () => {
    const p = await trozu.lens.position(1n);
    const nicr = nicrOf(p.collateral, p.principal) ?? 10n ** 20n;
    const [upper, lower] = await trozu.hints(nicr, 1n);
    expect(upper).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(lower).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 60_000);
});
