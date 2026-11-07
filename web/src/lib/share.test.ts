import { describe, expect, it } from "vitest";
import { missingCard, parseTokenId, parseWave, positionCard, proofCard, siteUrl, unavailableCard, type CardSource } from "./share";
import type { Proof } from "./content";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const src: CardSource = {
  tokenId: 4n,
  vault: "0x1D5acd83cd4D87F26533A364394e206199af7464",
  active: true,
  priceOk: true,
  coll: e18(0.05),
  debt: e18(1_992),
  icr: e18(2.05),
  lockedRateBps: 100,
  globalRateBps: 300,
};

describe("link parsing", () => {
  it("accepts only wave 1 and 2", () => {
    expect(parseWave("1")).toBe("1");
    expect(parseWave("2")).toBe("2");
    expect(parseWave("3")).toBeUndefined();
    expect(parseWave("")).toBeUndefined();
    expect(parseWave("v2")).toBeUndefined();
  });

  it("accepts plain token ids", () => {
    expect(parseTokenId("0")).toBe(0n);
    expect(parseTokenId("42")).toBe(42n);
    expect(parseTokenId("999999999999999999")).toBe(999999999999999999n);
  });

  it("rejects anything else, so a path cannot carry more than a number", () => {
    for (const bad of ["", "-1", "01", "1.5", "0x10", "1e3", " 1", "1 ", "../1", "1000000000000000000", "٣", "1;2"]) {
      expect(parseTokenId(bad), bad).toBeUndefined();
    }
  });
});

describe("position card", () => {
  it("shows public numbers from the lens", () => {
    const c = positionCard(src, "2", false);
    expect(c.title).toBe("Position #4");
    expect(c.chip).toEqual({ text: "Healthy", level: "safe" });
    expect(c.stats.map((s) => s.value)).toEqual(["205.0%", "0.05000 BTC", "1,992.00 MUSD", "1.00% vs 3.00% market"]);
    expect(c.subtitle).toContain("market-ready");
  });

  it("carries no holder or wallet field", () => {
    const text = JSON.stringify(positionCard({ ...src, ...({ holder: "0xdeadbeef", owner: "0xabc" } as object) } as CardSource, "1", false));
    expect(text).not.toMatch(/holder|owner|0xdeadbeef|0xabc/i);
  });

  it("only shortens the vault address", () => {
    expect(positionCard(src, "1", false).subtitle).toContain("0x1D5a…7464");
  });

  it("never calls stale numbers healthy", () => {
    const c = positionCard(src, "1", true);
    expect(c.chip?.level).toBe("stale");
    expect(c.stats[0].value).toBe("unverified");
  });

  it("does not show a ratio when the price feed is down", () => {
    const c = positionCard({ ...src, priceOk: false, icr: 0n }, "1", false);
    expect(c.stats[0].value).toBe("price feed down");
    expect(c.chip?.level).toBe("none");
  });

  it("shows no rate comparison when the locked rate is not below the market", () => {
    expect(positionCard({ ...src, globalRateBps: 100 }, "1", false).stats[3].value).toBe("1.00%");
    expect(positionCard({ ...src, globalRateBps: 50 }, "1", false).stats[3].value).toBe("1.00%");
  });

  it("marks a closed position", () => {
    expect(positionCard({ ...src, active: false }, "1", false).chip?.text).toBe("No open trove");
  });

  it("says no debt for the sentinel ratio", () => {
    expect(positionCard({ ...src, debt: 0n, icr: 2n ** 256n - 1n }, "1", false).stats[0].value).toBe("no debt");
  });
});

describe("fallback cards", () => {
  it("names no numbers when the chain cannot be read", () => {
    const c = unavailableCard(7n);
    expect(c.stats).toEqual([]);
    expect(c.subtitle).toMatch(/not available/);
    expect(c.title).toBe("Position #7");
  });

  it("has a generic title when the id is not known", () => {
    expect(unavailableCard(undefined).title).toBe("Trozu position");
  });

  it("says when there is no such position", () => {
    expect(missingCard(9n).subtitle).toMatch(/no position/);
  });
});

describe("proof card", () => {
  const proof: Proof = {
    updated: "2026-11-07",
    summary: { tests: 300, passing: 299, invariants: 8, note: null },
    claims: [
      { id: "a", claim: "x", status: "verified", how: "y", evidence: [] },
      { id: "b", claim: "x", status: "open", how: "y", evidence: [] },
    ],
    deployments: [
      { name: "n", address: "0x" + "1".repeat(40), explorer: "https://e.org", verification: "exact" },
      { name: "m", address: "0x" + "2".repeat(40), explorer: "https://e.org", verification: "none" },
    ],
  };

  it("counts what is in the file and nothing else", () => {
    const c = proofCard({ ok: true, data: proof });
    expect(c.stats).toEqual([
      { label: "Tests passing", value: "299 of 300" },
      { label: "Claims verified", value: "1 of 2" },
      { label: "Deployments", value: "1 of 2 source matched" },
    ]);
  });

  it("says not recorded and none listed for an empty file", () => {
    const c = proofCard({ ok: true, data: { updated: null, summary: { tests: null, passing: null, invariants: null, note: null }, claims: [], deployments: [] } });
    expect(c.stats.map((s) => s.value)).toEqual(["not recorded", "none listed", "none listed"]);
  });

  it("shows no numbers for a file that failed its checks", () => {
    expect(proofCard({ ok: false }).stats).toEqual([]);
  });
});

describe("site url", () => {
  it("prefers the explicit setting, then the Vercel domain, then localhost", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://a.example", VERCEL_PROJECT_PRODUCTION_URL: "b.example" }).origin).toBe("https://a.example");
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "b.example" }).origin).toBe("https://b.example");
    expect(siteUrl({}).origin).toBe("http://localhost:3000");
  });

  it("falls back when the value is not a URL", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "not a url" }).origin).toBe("http://localhost:3000");
  });
});
