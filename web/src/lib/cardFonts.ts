import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CardFont {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
}

/** Sora, SIL Open Font License (see OFL.txt beside the files). Shipped in the repo, read from disk, never fetched. */
export const FONT_DIR = path.join(process.cwd(), "src", "assets", "fonts");
export const FONT_FILES = [
  { file: "Sora-Regular.ttf", weight: 400 },
  { file: "Sora-Bold.ttf", weight: 700 },
] as const;

let loaded: Promise<CardFont[] | undefined> | undefined;

/**
 * The fonts for the share images. Image rendering needs TTF, OTF or WOFF data, which the app's own woff2 files are not,
 * so two TTF files sit in the repo. They are read once from disk: nothing here touches the network, so an image never
 * waits on, or breaks with, a font host. If a file is somehow missing the image falls back to the renderer's default
 * font rather than failing.
 */
export function loadCardFonts(dir = FONT_DIR): Promise<CardFont[] | undefined> {
  if (dir !== FONT_DIR) return read(dir);
  loaded ??= read(dir);
  return loaded;
}

async function read(dir: string): Promise<CardFont[] | undefined> {
  try {
    return await Promise.all(
      FONT_FILES.map(async (f) => ({ name: "Sora", data: await readFile(path.join(dir, f.file)), weight: f.weight, style: "normal" as const })),
    );
  } catch {
    return undefined;
  }
}
