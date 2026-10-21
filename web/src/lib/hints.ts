import { hintHelpersAbi, sortedTrovesAbi } from "@/abi/mezo";
import { config } from "@/config";

type Address = `0x${string}`;

export interface ReadClient {
  readContract: (args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
}

export const GAS_COMPENSATION = 200n * 10n ** 18n;
const NICR_PRECISION = 10n ** 20n;

/** The sorted list is keyed by coll * 1e20 / principal. For a new trove that is its composite debt. */
export function nicrAfterOpen(coll: bigint, debt: bigint, fee: bigint): bigint {
  return (coll * NICR_PRECISION) / (debt + fee + GAS_COMPENSATION);
}

/**
 * Where in the sorted list a trove with this NICR belongs. Mezo uses the pair as
 * a starting point and walks from there. A wrong pair never reverts, it only costs
 * gas (measured 0.6M with a good hint against 4.5M with none, see docs/VERIFICATION.md),
 * so this runs at the confirm step, right before sending, to keep the gas low.
 */
export async function computeHints(
  client: ReadClient,
  nicr: bigint,
  seed: bigint = BigInt(Math.floor(Math.random() * 1_000_000)),
): Promise<readonly [Address, Address]> {
  const [approx] = (await client.readContract({
    address: config.mezo.hintHelpers,
    abi: hintHelpersAbi,
    functionName: "getApproxHint",
    args: [nicr, 50n, seed],
  })) as readonly [Address, bigint, bigint];

  const [upper, lower] = (await client.readContract({
    address: config.mezo.sortedTroves,
    abi: sortedTrovesAbi,
    functionName: "findInsertPosition",
    args: [nicr, approx, approx],
  })) as readonly [Address, Address];

  return [upper, lower];
}
