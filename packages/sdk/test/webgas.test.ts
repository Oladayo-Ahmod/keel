import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GAS_TABLE, gasLimitFor, SDK_ONLY } from "../src/gas.js";

// the web app's table, read from the repository. The SDK's table is a copy and must not drift from it.
import { GAS_RULES as WEB_RULES, gasLimitFor as webLimit } from "../../../web/src/lib/gas.js";

const here = dirname(fileURLToPath(import.meta.url));
const roundtrip = JSON.parse(readFileSync(join(here, "..", "..", "..", "docs", "roundtrip.json"), "utf8")) as {
  results: { txs?: { fn: string; gasLimit: string; txStatus: string }[] }[];
};

describe("the SDK's gas table against web/src/lib/gas.ts", () => {
  it("has every action the web app has", () => {
    const missing = Object.keys(WEB_RULES).filter((n) => !(n in GAS_TABLE));
    expect(missing).toEqual([]);
  });

  it("sends the same limit as the web app for each of them", () => {
    for (const name of Object.keys(WEB_RULES)) expect(gasLimitFor(name), name).toBe(webLimit(name));
  });

  it("has nothing the web app lacks except the listed SDK-only actions", () => {
    const extra = Object.keys(GAS_TABLE).filter((n) => !(n in WEB_RULES));
    expect(extra.sort()).toEqual([...SDK_ONLY].sort());
  });

  it("agrees with the measured values the web app records", () => {
    for (const [name, rule] of Object.entries(WEB_RULES)) {
      const mine = GAS_TABLE[name]!;
      if (rule.measured === null) expect(mine.basis === "measured", `${name} is measured here but not in the web table`).toBe(false);
      else if (mine.basis === "measured") expect(mine.gasUsed, name).toBe(rule.measured);
    }
  });
});

describe("the SDK's gas table against the wallet round trip", () => {
  const sent = roundtrip.results.flatMap((r) => r.txs ?? []).filter((t) => t.txStatus === "success");

  it("has at least the limits the round trip sent", () => {
    expect(sent.length).toBeGreaterThan(10);
    for (const t of sent) expect(gasLimitFor(t.fn), t.fn).toBeGreaterThanOrEqual(Number(t.gasLimit));
  });

  it("calls an action `roundtrip` or `measured` only if there is evidence for it", () => {
    const ran = new Set(sent.map((t) => t.fn));
    for (const [name, g] of Object.entries(GAS_TABLE)) {
      if (g.basis === "roundtrip") expect(ran.has(name), `${name} is labelled roundtrip but is not in docs/roundtrip.json`).toBe(true);
    }
  });
});
