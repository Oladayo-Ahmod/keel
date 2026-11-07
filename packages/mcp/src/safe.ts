import { getAddress, isAddress, parseUnits } from "viem";
import { z } from "zod";

/**
 * Everything the server prints that did not come from its own code passes through here. The chain is
 * untrusted: anyone can announce a listing, name a token or write a revert string. So chain data is
 * only ever shown as (a) numbers and hashes that have been checked against a strict shape, or
 * (b) text that has been stripped of control and invisible characters, escaped and cut short, and
 * wrapped as `{ untrusted: true, text }` so a model can tell it is data and not an instruction.
 */

export const MAX_TEXT = 200;
/** A tool result is never bigger than this many characters of JSON. */
export const MAX_RESULT_CHARS = 40_000;

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
// zero-width, bidi overrides and isolates, soft hyphen, byte order mark, line and paragraph separators
const INVISIBLE_RANGES: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];
const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join("")}]`, "g");

/** Plain, short, inert text. Safe to put inside a JSON string or a markdown or HTML page. */
export function cleanText(input: unknown, max = MAX_TEXT): string {
  let t = typeof input === "string" ? input : String(input ?? "");
  t = t.replace(ANSI, "").replace(CONTROL, " ").replace(INVISIBLE, "");
  t = t.normalize("NFKC");
  t = t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "'")
    .replace(/\]\(/g, "] (");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Chain-supplied text, marked as such. */
export function untrusted(text: unknown, max = MAX_TEXT): { untrusted: true; text: string } {
  return { untrusted: true, text: cleanText(text, max) };
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** A transaction or listing hash, or nothing if it is not exactly 32 bytes of hex. */
export const hash32 = (v: unknown): string | null => (typeof v === "string" && HEX32.test(v) ? v.toLowerCase() : null);

/** A checksummed address, or nothing if it is not exactly 20 bytes of hex. */
export const addressOut = (v: unknown): string | null => (typeof v === "string" && ADDR.test(v) ? getAddress(v) : null);

/** Wei as an exact decimal string. Nothing is ever turned into a float. */
export const wei = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

/** JSON.stringify that survives bigint. */
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** Throws if the serialised result is over the cap, so an oversized answer never reaches the model. */
export function capped(v: unknown): string {
  const s = json(v);
  if (s.length > MAX_RESULT_CHARS) throw new Error(`result is larger than ${MAX_RESULT_CHARS} characters`);
  return s;
}

// ---- input schemas ----------------------------------------------------------------------------------------

export const addressIn = z
  .string()
  .max(42)
  .refine((v) => isAddress(v, { strict: false }), "not a valid 20-byte hex address")
  .transform((v) => getAddress(v));

export const tokenIdIn = z
  .union([z.string().regex(/^\d{1,20}$/, "not a whole number"), z.number().int().nonnegative().safe()])
  .transform((v) => BigInt(v));

export const hashIn = z
  .string()
  .regex(HEX32, "not a 32-byte hex hash")
  .transform((v) => v.toLowerCase() as `0x${string}`);

/** "0.25" as wei. Up to 18 decimals, no signs, no exponents. */
export const amountIn = z
  .string()
  .regex(/^\d{1,30}(\.\d{1,18})?$/, "not a plain decimal amount like 0.25")
  .transform((v) => parseUnits(v, 18));

/** "130" or "130.5" as a 1e18 ratio. */
export const percentIn = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, "not a percentage like 130 or 130.5")
  .transform((v) => parseUnits(v, 16));
