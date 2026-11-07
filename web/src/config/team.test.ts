import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTeam, readTeam, team, teamSet } from "./team";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);

describe("team wallets", () => {
  it("reads the deployer, second wallet, keeper and fee recipient", () => {
    const t = readTeam({ market: { feeRecipient: D } }, { wallets: { deployer: A, second: B, keeper: C } });
    expect(t).toEqual({ deployer: A, second: B, keeper: C, feeRecipient: D });
    expect(teamSet(t).size).toBe(4);
  });

  it("throws when a wallet is missing or malformed instead of using a shorter list", () => {
    const d = { market: { feeRecipient: D } };
    expect(() => readTeam(d, {})).toThrow(/deployer/);
    expect(() => readTeam(d, { wallets: { deployer: A, second: B } })).toThrow(/keeper/);
    expect(() => readTeam(d, { wallets: { deployer: A, second: "0x12", keeper: C } })).toThrow(/second/);
    expect(() => readTeam({ market: { feeRecipient: "" } }, { wallets: { deployer: A, second: B, keeper: C } })).toThrow(/feeRecipient/);
  });

  it("matches case-insensitively", () => {
    const t = readTeam({ market: { feeRecipient: A } }, { wallets: { deployer: A, second: B, keeper: C } });
    expect(isTeam(A.toUpperCase().replace("0X", "0x"), t)).toBe(true);
    expect(isTeam(D, t)).toBe(false);
  });

  it("is the real deployment's team: fee recipient is the deployer", () => {
    expect(team.feeRecipient.toLowerCase()).toBe(team.deployer.toLowerCase());
  });

  it("agrees with the wallets of the live proof run in docs/proof.json", () => {
    const run = JSON.parse(readFileSync(new URL("../../../docs/proof.json", import.meta.url), "utf8")).wallets;
    expect(team.deployer.toLowerCase()).toBe(run.deployer.toLowerCase());
    expect(team.second.toLowerCase()).toBe(run.second.toLowerCase());
    expect(team.keeper.toLowerCase()).toBe(run.keeper.toLowerCase());
    expect(team.feeRecipient.toLowerCase()).toBe(run.feeRecipient.toLowerCase());
  });
});
