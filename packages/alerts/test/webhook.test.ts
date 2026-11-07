import { describe, expect, it, vi } from "vitest";
import type { Alert } from "../src/check.js";
import { buildPayload, detectFormat, hostOf, post, renderText, urlProblem, WebhookError } from "../src/webhook.js";

const alert = (over: Partial<Alert> = {}): Alert => ({
  kind: "near-floor",
  severity: "warning",
  tokenId: "7",
  vault: "0x3333333333333333333333333333333333333333",
  title: "Position #7 is near its guardian floor",
  message: "Position #7 is at 138% against its 130% floor, 8 points of room.",
  key: "near-floor:7",
  data: { icrPercent: 138 },
  ...over,
});

const SECRET = "https://hooks.example.com/services/T000/B000/s3cr3t-token";
const res = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

describe("payload", () => {
  it("renders title and message for every alert", () => {
    expect(renderText([alert(), alert({ severity: "critical", title: "T2", message: "M2" })])).toBe(
      "🟠 Position #7 is near its guardian floor\nPosition #7 is at 138% against its 130% floor, 8 points of room.\n\n🔴 T2\nM2",
    );
  });

  it("uses the shape each service expects, and chooses by host when asked to", () => {
    const a = [alert()];
    expect(buildPayload(a, "slack")).toEqual({ text: renderText(a) });
    expect(buildPayload(a, "discord")).toEqual({ content: renderText(a) });
    expect(buildPayload(a, "json")).toEqual({ text: renderText(a), alerts: a });
    expect(detectFormat("https://hooks.slack.com/services/x")).toBe("slack");
    expect(detectFormat("https://discord.com/api/webhooks/1/x")).toBe("discord");
    expect(detectFormat("https://example.com/hook")).toBe("json");
    expect(buildPayload(a, "auto", "https://hooks.slack.com/services/x")).toEqual({ text: renderText(a) });
  });

  it("keeps a Discord message under its 2000 character limit", () => {
    const many = Array.from({ length: 40 }, () => alert());
    const p = buildPayload(many, "discord") as { content: string };
    expect(p.content.length).toBeLessThanOrEqual(1900);
  });
});

describe("url", () => {
  it("must be https, except for a local test server", () => {
    expect(urlProblem(SECRET)).toBeNull();
    expect(urlProblem("http://example.com/x")).toMatch(/https/);
    expect(urlProblem("http://localhost:8080/x")).toBeNull();
    expect(urlProblem("ftp://example.com")).toMatch(/https/);
    expect(urlProblem("not a url")).toMatch(/valid URL/);
  });

  it("is shown as its host only", () => {
    expect(hostOf(SECRET)).toBe("hooks.example.com");
    expect(hostOf("junk")).toBe("(invalid url)");
  });
});

describe("post", () => {
  const opts = { backoffMs: 0 };

  it("sends the JSON once on success", async () => {
    const f = vi.fn().mockResolvedValue(res(200));
    await post(SECRET, { text: "hi" }, { ...opts, fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(SECRET);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "hi" });
  });

  it("retries once after a 5xx and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    await post(SECRET, {}, { ...opts, fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries after a network error, and a 429", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    await post(SECRET, {}, { ...opts, retries: 2, fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx, which will not get better", async () => {
    const f = vi.fn().mockResolvedValue(res(404));
    await expect(post(SECRET, {}, { ...opts, fetchImpl: f })).rejects.toThrow(/HTTP 404/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retries, and the error does not contain the secret url", async () => {
    const f = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED ${SECRET}`));
    const err = await post(SECRET, {}, { ...opts, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookError);
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(err.message)).not.toContain("s3cr3t");
    expect(String(err.message)).not.toContain("hooks.example.com");
  });

  it("times out a webhook that never answers", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))));
    await expect(post(SECRET, {}, { ...opts, retries: 0, timeoutMs: 20, fetchImpl: f as never })).rejects.toThrow(/did not answer in time/);
  });

  it("refuses a plain http url before sending anything", async () => {
    const f = vi.fn();
    await expect(post("http://example.com/x", {}, { fetchImpl: f })).rejects.toThrow(/https/);
    expect(f).not.toHaveBeenCalled();
  });
});
