import raw from "./deployment.v2.json";

type Address = `0x${string}`;

/**
 * Market and guardian addresses, read straight from deployment.v2.json, which is the one source
 * of truth shared with the keeper and the proof script (scripts/check-deployment.mjs checks every
 * address in it has code on chain). Everything wave 2 is hidden behind `enabled`, so the app ships
 * unchanged until the integrator builds with NEXT_PUBLIC_WAVE2=1.
 */
export const wave2 = {
  enabled: process.env.NEXT_PUBLIC_WAVE2 === "1",
  deployBlock: BigInt(raw.deployedAtBlock),
  factory: raw.trozu.factory as Address,
  nft: raw.trozu.nft as Address,
  lens: raw.trozu.lens as Address,
  vaultImplementation: raw.trozu.vaultImplementation as Address,
  market: raw.trozu.market as Address,
  feeBps: raw.market.feeBps,
  feeRecipient: raw.market.feeRecipient as Address,
  hintHelpers: raw.mezo.hintHelpers as Address,
} as const;

/** Mezo's public RPC rejects eth_getLogs over 10,000 blocks (docs/DECISIONS.md 27), so logs are read in windows. */
export const LOG_WINDOW = 9_000n;
