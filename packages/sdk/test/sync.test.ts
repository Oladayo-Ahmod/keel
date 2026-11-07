import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("generated files", () => {
  it("match the ABIs and the deployment record at the repository root", () => {
    // exits non-zero, and so throws, if src/generated has drifted from abi/v2 or deployment.v2.json
    const out = execFileSync("node", [join(here, "..", "scripts", "sync.mjs"), "--check"], { encoding: "utf8" });
    expect(out).toBe("");
  });
});
