import raw from "./wave2.json";

type Address = `0x${string}`;

/**
 * Market and guardian addresses. Everything wave 2 is hidden behind `enabled`, so the app ships
 * unchanged until the contracts are merged and the integrator flips the flag in wave2.json
 * or builds with NEXT_PUBLIC_WAVE2=1.
 */
export const wave2 = {
  enabled: process.env.NEXT_PUBLIC_WAVE2 === "1" || raw.enabled,
  deployBlock: BigInt(raw.deployBlock),
  factory: raw.factory as Address,
  nft: raw.nft as Address,
  lens: raw.lens as Address,
  vaultImplementation: raw.vaultImplementation as Address,
  market: raw.market as Address,
} as const;

/** Mezo's public RPC rejects eth_getLogs over 10,000 blocks (docs/DECISIONS.md 27), so logs are read in windows. */
export const LOG_WINDOW = 9_000n;
