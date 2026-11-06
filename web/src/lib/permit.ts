import { hashDomain, parseSignature, type Hex } from "viem";

type Address = `0x${string}`;

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PermitDomain {
  name: string;
  chainId: number;
  verifyingContract: Address;
}

/** MUSD is OpenZeppelin's ERC20Permit, whose EIP-712 version is "1". */
export const PERMIT_VERSION = "1";

export function permitDomain(d: PermitDomain) {
  return { name: d.name, version: PERMIT_VERSION, chainId: d.chainId, verifyingContract: d.verifyingContract } as const;
}

/**
 * Whether the domain assembled here hashes to the token's own DOMAIN_SEPARATOR. If it does
 * not, a signature would be rejected by the token and the vault would silently fall back to
 * a plain transfer that fails, so the app uses an approve transaction instead.
 */
export function domainMatches(d: PermitDomain, onChainSeparator: Hex): boolean {
  const mine = hashDomain({
    domain: permitDomain(d),
    types: { EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ] },
  });
  return mine.toLowerCase() === onChainSeparator.toLowerCase();
}

export function permitMessage(p: { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint }) {
  return { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline } as const;
}

/** Splits a wallet signature into the v, r, s the vault takes. */
export function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  const parsed = parseSignature(sig);
  const v = parsed.v !== undefined ? Number(parsed.v) : 27 + parsed.yParity;
  return { v, r: parsed.r, s: parsed.s };
}

/** A permit is good for ten minutes, long enough to confirm and short enough to be harmless if it leaks. */
export const PERMIT_WINDOW_SECONDS = 600n;
