import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/config";
import { wave2 } from "@/config/wave2";
import { lensFor } from "./lens";

describe("the lens for a position", () => {
  it("is the wave 2 lens for a wave 2 position and the wave 1 lens otherwise, and they differ", () => {
    expect(lensFor(true)).toBe(wave2.lens);
    expect(lensFor(false)).toBe(config.keel.lens);
    expect(wave2.lens.toLowerCase()).not.toBe(config.keel.lens.toLowerCase());
  });

  it("is what the buffer panel and the simulator read from, not a hardcoded wave 1 lens", () => {
    // this was a bug: both asked the wave 1 lens about a wave 2 token id, so the buffer check never worked for wave 2 positions
    for (const f of ["components/BufferPanel.tsx", "components/WhatIf.tsx"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src, f).not.toMatch(/address:\s*config\.keel\.lens/);
      expect(src, f).toMatch(/lens/);
    }
    const card = readFileSync(join(__dirname, "..", "components/PositionCard.tsx"), "utf8");
    expect(card).toMatch(/lens=\{lensFor\(v2\)\}/);
  });
});
