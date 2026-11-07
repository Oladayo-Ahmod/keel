import { describe, expect, it } from "vitest";
import { createTrozu } from "../src/client.js";
import { TrozuValidationError, TrozuRevertError } from "../src/errors.js";
import { vaultAbi } from "../src/generated/abis.js";
import { ADDR, mockChain, Revert } from "./mockChain.js";

function setup(execute: () => unknown) {
  const m = mockChain();
  m.contract(ADDR.vault, vaultAbi as never, { execute });
  return { m, trozu: createTrozu({ client: m.client, deployment: m.deployment }) };
}

describe("simulate", () => {
  it("says ok when the call would go through, and sends it with the builder's gas limit", async () => {
    const { m, trozu } = setup(() => [1, 10n, 5n]);
    const tx = trozu.tx.execute({ vault: ADDR.vault });
    expect(await trozu.simulate(tx, ADDR.bob)).toEqual({ ok: true });
    const call = m.requests.find((r) => r.method === "eth_call")!.params as { from: string; gas: string }[];
    expect(call[0]?.from.toLowerCase()).toBe(ADDR.bob);
    expect(BigInt(call[0]!.gas)).toBe(tx.gas);
    expect(m.requests.some((r) => r.method === "eth_estimateGas")).toBe(false);
  });

  it("returns a revert as a typed error instead of throwing", async () => {
    const { trozu } = setup(() => {
      throw new Revert(vaultAbi as never, "NothingToDo", [5]);
    });
    const r = await trozu.simulate(trozu.tx.execute({ vault: ADDR.vault }), ADDR.bob);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(TrozuRevertError);
      expect((r.error as TrozuRevertError).errorName).toBe("NothingToDo");
    }
  });

  it("refuses a sender that is not an address", async () => {
    const { trozu } = setup(() => [0, 0n, 0n]);
    await expect(trozu.simulate(trozu.tx.execute({ vault: ADDR.vault }), "bob")).rejects.toBeInstanceOf(TrozuValidationError);
  });
});

describe("simulate with a state override", () => {
  it("passes the override to eth_call, and sends nothing else", async () => {
    const { m, trozu } = setup(() => [0, 0n, 0n]);
    const override = [{ address: ADDR.bob, balance: 5n }];
    await trozu.simulate(trozu.tx.execute({ vault: ADDR.vault }), ADDR.alice, { stateOverride: override });
    const call = m.requests.find((r) => r.method === "eth_call")!.params as unknown[];
    expect(call[2]).toEqual({ [ADDR.bob]: { balance: "0x5" } });
    expect(m.requests.every((r) => r.method === "eth_call" || r.method === "eth_chainId")).toBe(true);
  });
});
