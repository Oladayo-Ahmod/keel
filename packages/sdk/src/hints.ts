import { parseAbi } from "viem";
import { guarded, type Context } from "./context.js";
import type { Address } from "./types.js";

/** Only the two Mezo reads the hints need. */
const hintHelpersAbi = parseAbi(["function getApproxHint(uint256 cr, uint256 numTrials, uint256 inputRandomSeed) view returns (address hintAddress, uint256 diff, uint256 latestRandomSeed)"]);
const sortedTrovesAbi = parseAbi(["function findInsertPosition(uint256 nicr, address prevId, address nextId) view returns (address, address)"]);

const NICR_PRECISION = 10n ** 20n;
export const GAS_COMPENSATION = 200n * 10n ** 18n;

/** The sorted list is keyed by coll * 1e20 / principal. For a new trove the principal is its composite debt. */
export function nicrAfterOpen(coll: bigint, debt: bigint, fee: bigint): bigint {
  return (coll * NICR_PRECISION) / (debt + fee + GAS_COMPENSATION);
}

export function nicrOf(coll: bigint, principal: bigint): bigint | undefined {
  return principal === 0n ? undefined : (coll * NICR_PRECISION) / principal;
}

/**
 * Where in Mezo's sorted list a trove with this NICR belongs. Mezo uses the pair as a starting point
 * and walks from there, so a wrong pair never reverts, it only costs gas (about 0.6M with a good hint
 * against 4.5M with none, docs/VERIFICATION.md). Compute it right before sending.
 */
export async function computeHints({ client, deployment }: Context, nicr: bigint, seed: bigint = BigInt(Math.floor(Math.random() * 1_000_000))): Promise<readonly [Address, Address]> {
  const [approx] = await guarded(() =>
    client.readContract({ address: deployment.mezo.hintHelpers, abi: hintHelpersAbi, functionName: "getApproxHint", args: [nicr, 50n, seed] }),
  );
  const [upper, lower] = await guarded(() =>
    client.readContract({ address: deployment.mezo.sortedTroves, abi: sortedTrovesAbi, functionName: "findInsertPosition", args: [nicr, approx, approx] }),
  );
  return [upper, lower];
}
