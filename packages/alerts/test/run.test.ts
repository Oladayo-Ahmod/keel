import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig, run } from "../src/run.js";
import { ADDR, chain, E18 } from "./fixture.js";

const SECRET = "https://hooks.example.com/services/T000/B000/s3cr3t-token";
const pct = (n: number) => (BigInt(Math.round(n * 100)) * E18) / 10_000n;

function harness(env: Record<string, string>, o: Parameters<typeof chain>[0] = {}, argv: string[] = [], fetchImpl?: typeof fetch, cwd = mkdtempSync(join(tmpdir(), "alerts-cwd-"))) {
  const c = chain(o);
  const out: string[] = [];
  const err: string[] = [];
  const f = fetchImpl ?? (vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch);
  const code = () =>
    run({
      env,
      argv,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      makeChain: () => ({ trozu: c.trozu, client: c.client }),
      post: { fetchImpl: f, backoffMs: 0 },
      now: () => 1_800_000_000_000,
      cwd,
    });
  return { c, out, err, f: f as unknown as ReturnType<typeof vi.fn>, code, cwd };
}

describe("config", () => {
  it("needs something to watch and somewhere to send", () => {
    expect(() => parseConfig({}, [])).toThrow(/TOKEN_IDS or HOLDERS/);
    expect(() => parseConfig({ TOKEN_IDS: "1" }, [])).toThrow(/WEBHOOK_URL/);
    expect(parseConfig({ TOKEN_IDS: "1" }, ["--dry-run"]).dryRun).toBe(true);
    expect(parseConfig({ TOKEN_IDS: "1", DRY_RUN: "1" }, []).webhookUrl).toBeUndefined();
  });

  it("parses lists and numbers strictly", () => {
    const c = parseConfig({ TOKEN_IDS: "1, 2", HOLDERS: ADDR.alice.toLowerCase(), WEBHOOK_URL: SECRET, MARGIN_POINTS: "7.5", COOLDOWN_MINUTES: "30" }, []);
    expect(c.tokenIds).toEqual([1n, 2n]);
    expect(c.holders).toEqual([ADDR.alice]);
    expect(c.marginPoints).toBe(7.5);
    expect(c.cooldownSeconds).toBe(1800);
    expect(() => parseConfig({ TOKEN_IDS: "1,x", WEBHOOK_URL: SECRET }, [])).toThrow(/TOKEN_IDS/);
    expect(() => parseConfig({ HOLDERS: "0x12", WEBHOOK_URL: SECRET }, [])).toThrow(/HOLDERS/);
    expect(() => parseConfig({ TOKEN_IDS: "1", WEBHOOK_URL: SECRET, MARGIN_POINTS: "-1" }, [])).toThrow(/MARGIN_POINTS/);
    expect(() => parseConfig({ TOKEN_IDS: "1", WEBHOOK_URL: SECRET, WEBHOOK_FORMAT: "xml" }, [])).toThrow(/WEBHOOK_FORMAT/);
    expect(() => parseConfig({ TOKEN_IDS: "1", WEBHOOK_URL: "http://example.com/x" }, [])).toThrow(/https/);
  });
});

describe("dry run", () => {
  it("prints what it would send, names only the host, and sends nothing", async () => {
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET }, { icr: pct(135) }, ["--dry-run"]);
    expect(await h.code()).toBe(0);
    expect(h.f).not.toHaveBeenCalled();
    const text = h.out.join("\n");
    expect(text).toContain("dry run: would post 1 alert(s) to hooks.example.com");
    expect(text).toContain("Position #7 is at 135% against its 130% floor");
    expect(text + h.err.join("\n")).not.toContain("s3cr3t");
  });

  it("works with no webhook configured at all", async () => {
    const h = harness({ TOKEN_IDS: "7" }, { icr: pct(135) }, ["--dry-run"]);
    expect(await h.code()).toBe(0);
    expect(h.out.join("\n")).toContain("would post 1 alert(s)");
  });

  it("does not touch the state file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "alerts-")), "state.json");
    const h = harness({ TOKEN_IDS: "7", STATE_FILE: file }, { icr: pct(135) }, ["--dry-run"]);
    await h.code();
    expect(existsSync(file)).toBe(false);
  });
});

describe("a real run", () => {
  it("posts the alerts once and says only the host", async () => {
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET }, { icr: pct(135) });
    expect(await h.code()).toBe(0);
    expect(h.f).toHaveBeenCalledTimes(1);
    const body = JSON.parse(h.f.mock.calls[0]![1].body);
    expect(body.alerts[0]).toMatchObject({ kind: "near-floor", tokenId: "7" });
    expect(h.out.join("\n")).toBe("posted 1 alert(s) to hooks.example.com");
    expect(h.out.join("\n") + h.err.join("\n")).not.toContain("s3cr3t");
  });

  it("posts nothing when nothing is wrong", async () => {
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET }, { icr: pct(160) });
    expect(await h.code()).toBe(0);
    expect(h.f).not.toHaveBeenCalled();
    expect(h.out).toEqual(["no alerts"]);
  });

  it("finds positions through HOLDERS", async () => {
    const h = harness({ HOLDERS: ADDR.alice, WEBHOOK_URL: SECRET }, { icr: pct(135) });
    expect(await h.code()).toBe(0);
    expect(h.f).toHaveBeenCalledTimes(1);
  });

  it("reports a keeper action found in the lookback window", async () => {
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET, LOOKBACK_BLOCKS: "1000" }, { icr: pct(160) });
    h.c.action(1, E18 / 20n, 0n, pct(129), 16_699_500n);
    expect(await h.code()).toBe(0);
    expect(JSON.parse(h.f.mock.calls[0]![1].body).alerts[0].kind).toBe("keeper-acted");
  });

  it("exits 1, without the url, when the webhook is down", async () => {
    const f = vi.fn().mockRejectedValue(new Error(`boom ${SECRET}`)) as unknown as typeof fetch;
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET }, { icr: pct(135) }, [], f);
    expect(await h.code()).toBe(1);
    expect(h.err.join("\n")).toMatch(/failed: could not reach the webhook/);
    expect(h.err.join("\n")).not.toContain("s3cr3t");
  });

  it("exits 2 on a bad setting", async () => {
    const h = harness({ TOKEN_IDS: "nope", WEBHOOK_URL: SECRET });
    expect(await h.code()).toBe(2);
    expect(h.err[0]).toMatch(/^config:/);
  });
});

describe("state", () => {
  it("does not repeat a near-floor alert inside the cooldown, and does after it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "alerts-")), "state.json");
    const env = { TOKEN_IDS: "7", WEBHOOK_URL: SECRET, STATE_FILE: file, COOLDOWN_MINUTES: "60" };
    const h = harness(env, { icr: pct(135) });
    await h.code();
    expect(h.f).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.sent["near-floor:7"]).toBe(1_800_000_000);
    expect(saved.lastBlock).toBe("16700000");

    // the same minute again: cooled down. lastBlock is now the head, so there is nothing to read either
    const again = harness(env, { icr: pct(135) });
    await again.code();
    expect(again.f).not.toHaveBeenCalled();

    // two hours later, the cooldown is over
    saved.lastBlock = "16699000";
    saved.sent["near-floor:7"] = 1_800_000_000 - 7_200;
    writeFileSync(file, JSON.stringify(saved));
    const later = harness(env, { icr: pct(135) });
    await later.code();
    expect(later.f).toHaveBeenCalledTimes(1);
  });

  it("carries on from the last block it read, so a keeper action is reported once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "alerts-")), "state.json");
    writeFileSync(file, JSON.stringify({ version: 1, lastBlock: "16699000", sent: {} }));
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET, STATE_FILE: file }, { icr: pct(160) });
    h.c.action(1, E18, 0n, pct(129), 16_698_000n); // before the saved block: already reported
    h.c.action(1, E18, 0n, pct(129), 16_699_500n); // new
    await h.code();
    const alerts = JSON.parse(h.f.mock.calls[0]![1].body).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data.block).toBe("16699500");
  });

  it("starts clean from a corrupt state file instead of failing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "alerts-")), "state.json");
    writeFileSync(file, "{not json");
    const h = harness({ TOKEN_IDS: "7", WEBHOOK_URL: SECRET, STATE_FILE: file }, { icr: pct(135) });
    expect(await h.code()).toBe(0);
    expect(h.f).toHaveBeenCalledTimes(1);
  });
});

describe("the default state file", () => {
  const SECRET_ENV = { TOKEN_IDS: "7", WEBHOOK_URL: SECRET };

  it("is a relative path under the working directory, which is what actions/cache can save", () => {
    const c = parseConfig(SECRET_ENV, [], "/work/packages");
    expect(c.stateFile).toBe("/work/packages/.trozu-alerts/state.json");
    expect(parseConfig({ ...SECRET_ENV, STATE_FILE: "mine/s.json" }, [], "/work").stateFile).toBe("/work/mine/s.json");
    expect(parseConfig({ ...SECRET_ENV, STATE_FILE: "none" }, [], "/work").stateFile).toBeUndefined();
  });

  it("is created on the first run, with the directory, and holds only block numbers and times", async () => {
    const h = harness(SECRET_ENV, { icr: pct(135) });
    await h.code();
    const file = join(h.cwd, ".trozu-alerts", "state.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["lastBlock", "sent", "version"]);
    expect(JSON.stringify(saved)).not.toContain("s3cr3t");
    expect(JSON.stringify(saved)).not.toContain("hooks.example.com");
  });

  it("stops a second run in the same directory repeating the first: a near-floor alert and a keeper action", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "alerts-cwd-"));
    const first = harness({ ...SECRET_ENV, LOOKBACK_BLOCKS: "2000" }, { icr: pct(135) }, [], undefined, cwd);
    first.c.action(1, E18 / 20n, 0n, pct(129), 16_699_500n);
    expect(await first.code()).toBe(0);
    const sent1 = JSON.parse(first.f.mock.calls[0]![1].body).alerts.map((a: { key: string }) => a.key).sort();
    expect(sent1).toHaveLength(2);
    expect(sent1[0]).toMatch(/^keeper:/);
    expect(sent1[1]).toBe("near-floor:7");

    // same chain, same position, same directory, a minute later: nothing new to say
    const second = harness({ ...SECRET_ENV, LOOKBACK_BLOCKS: "2000" }, { icr: pct(135) }, [], undefined, cwd);
    second.c.action(1, E18 / 20n, 0n, pct(129), 16_699_500n);
    expect(await second.code()).toBe(0);
    expect(second.f).not.toHaveBeenCalled();
    expect(second.out).toEqual(["no alerts"]);
  });

  it("with STATE_FILE=none every run says everything again", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "alerts-cwd-"));
    const env = { ...SECRET_ENV, STATE_FILE: "none" };
    const a = harness(env, { icr: pct(135) }, [], undefined, cwd);
    await a.code();
    const b = harness(env, { icr: pct(135) }, [], undefined, cwd);
    await b.code();
    expect(a.f).toHaveBeenCalledTimes(1);
    expect(b.f).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cwd, ".trozu-alerts"))).toBe(false);
  });
});
