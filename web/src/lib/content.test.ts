import { describe, expect, it } from "vitest";
import breakIt from "@/content/break-it.json";
import proof from "@/content/proof.json";
import { parseBreakIt, parseProof, safeHref } from "./content";

const attempt = {
  id: "A1", title: "Drain after listing", threat: "T1", attack: "List, then withdraw collateral.",
  result: "blocked", why: "The buyer's bounds revert the sale.", evidence: [{ label: "test", href: "https://example.org/t" }],
};

describe("links", () => {
  it("allows https, local http and site paths only", () => {
    expect(safeHref("https://explorer.test.mezo.org/tx/0x1")).toBe(true);
    expect(safeHref("http://localhost:3000/x")).toBe(true);
    expect(safeHref("/proof")).toBe(true);
    expect(safeHref("javascript:alert(1)")).toBe(false);
    expect(safeHref("data:text/html,x")).toBe(false);
    expect(safeHref("http://evil.example")).toBe(false);
    expect(safeHref("//evil.example")).toBe(false);
    expect(safeHref("https://a b")).toBe(false);
    expect(safeHref(undefined)).toBe(false);
  });
});

describe("the files as shipped", () => {
  it("are valid and empty, so no page invents a number", () => {
    const b = parseBreakIt(breakIt);
    const p = parseProof(proof);
    expect(b.ok && b.data.attempts.length === 0 && b.data.updated === null).toBe(true);
    expect(p.ok && p.data.claims.length === 0 && p.data.summary.tests === null && p.data.deployments.length === 0).toBe(true);
  });
});

describe("break-it", () => {
  it("accepts a well-formed attempt", () => {
    const r = parseBreakIt({ updated: "2026-11-10", intro: "We tried.", attempts: [attempt] });
    expect(r.ok).toBe(true);
  });
  it("rejects a missing field, a bad result and a script link", () => {
    expect(parseBreakIt({ updated: null, intro: null, attempts: [{ ...attempt, why: "" }] }).ok).toBe(false);
    expect(parseBreakIt({ updated: null, intro: null, attempts: [{ ...attempt, result: "maybe" }] }).ok).toBe(false);
    const bad = parseBreakIt({ updated: null, intro: null, attempts: [{ ...attempt, evidence: [{ label: "x", href: "javascript:alert(1)" }] }] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join()).toMatch(/evidence 1/);
  });
  it("rejects a non-object and a non-list", () => {
    expect(parseBreakIt(null).ok).toBe(false);
    expect(parseBreakIt({ updated: null, intro: null, attempts: {} }).ok).toBe(false);
  });
});

describe("proof", () => {
  const good = {
    updated: "2026-11-10",
    summary: { tests: 10, passing: 10, invariants: 2, note: null },
    claims: [{ id: "C1", claim: "Only the holder moves funds.", status: "verified", how: "invariant", evidence: [] }],
    deployments: [{ name: "Market", address: "0xEae6fEa26B178eF32829F36e5219363bB30D93DB", explorer: "https://explorer.test.mezo.org/address/0x1", verification: "exact" }],
  };
  it("accepts a well-formed file", () => {
    expect(parseProof(good).ok).toBe(true);
  });
  it("rejects negative counts, a bad address and an unknown status", () => {
    expect(parseProof({ ...good, summary: { ...good.summary, tests: -1 } }).ok).toBe(false);
    expect(parseProof({ ...good, deployments: [{ ...good.deployments[0], address: "0x123" }] }).ok).toBe(false);
    expect(parseProof({ ...good, claims: [{ ...good.claims[0], status: "done" }] }).ok).toBe(false);
  });
});
