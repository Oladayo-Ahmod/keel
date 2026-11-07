import deployment from "./deployment.v2.json";
import proof from "../content/proof.json";

type Address = `0x${string}`;

export interface Team {
  deployer: Address;
  second: Address;
  keeper: Address;
  feeRecipient: Address;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The wallets the team itself used on testnet: the deployer (also the fee recipient), the second wallet that played the
 * buyer, and the keeper. They come from the same two files the rest of the app reads, deployment.v2.json (fee
 * recipient) and proof.json (the wallets of the live proof run). A missing or malformed entry throws, because a team
 * list that quietly came up short would count the team's own transactions as other people.
 */
export function readTeam(
  deploymentFile: { market: { feeRecipient: string } },
  proofFile: { wallets?: Record<string, unknown> },
): Team {
  const pick = (name: string, v: unknown): Address => {
    if (typeof v !== "string" || !ADDRESS.test(v)) throw new Error(`team wallet "${name}" is missing or not an address`);
    return v as Address;
  };
  const w = proofFile.wallets ?? {};
  return {
    deployer: pick("proof.json wallets.deployer", w.deployer),
    second: pick("proof.json wallets.second", w.second),
    keeper: pick("proof.json wallets.keeper", w.keeper),
    feeRecipient: pick("deployment.v2.json market.feeRecipient", deploymentFile.market.feeRecipient),
  };
}

export const team: Team = readTeam(deployment, proof);

/** Lowercase set of the team's addresses, for case-insensitive matching against log arguments. */
export function teamSet(t: Team = team): Set<string> {
  return new Set([t.deployer, t.second, t.keeper, t.feeRecipient].map((a) => a.toLowerCase()));
}

export const isTeam = (address: string, t: Team = team) => teamSet(t).has(address.toLowerCase());
