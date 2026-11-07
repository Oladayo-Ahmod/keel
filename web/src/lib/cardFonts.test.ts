import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_DIR, FONT_FILES, loadCardFonts } from "./cardFonts";

afterEach(() => vi.unstubAllGlobals());

describe("share image fonts", () => {
  it("ships both weights as TrueType files with the license beside them", () => {
    const files = readdirSync(FONT_DIR);
    for (const f of FONT_FILES) {
      expect(files).toContain(f.file);
      const bytes = readFileSync(path.join(FONT_DIR, f.file));
      expect(bytes.readUInt32BE(0)).toBe(0x00010000); // TrueType sfnt version
      expect(bytes.length).toBeGreaterThan(50_000);
    }
    expect(files).toContain("OFL.txt");
    expect(readFileSync(path.join(FONT_DIR, "OFL.txt"), "utf8")).toMatch(/SIL Open Font License/);
  });

  it("loads from disk without any network call", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network is not allowed")));
    vi.stubGlobal("fetch", fetchSpy);
    const fonts = await loadCardFonts(FONT_DIR + path.sep + ".");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fonts?.map((f) => f.weight)).toEqual([400, 700]);
    expect(fonts?.every((f) => f.name === "Sora" && f.data.length > 50_000)).toBe(true);
  });

  it("falls back to no custom font, not an error, when a file is missing", async () => {
    expect(await loadCardFonts(path.join(FONT_DIR, "does-not-exist"))).toBeUndefined();
  });

  it("has no font URL or fetch in the image code", () => {
    for (const f of ["cardFonts.ts", "cardImage.tsx"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/fetch\s*\(/);
      expect(src, f).not.toMatch(/https?:\/\/[^\s"']*(font|gstatic|googleapis)/i);
    }
  });
});
