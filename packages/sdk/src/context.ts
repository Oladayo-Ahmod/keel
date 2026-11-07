import { getAddress, isAddress, type PublicClient } from "viem";
import { decodeRevert, TrozuNotFoundError, TrozuValidationError } from "./errors.js";
import { nftAbi } from "./generated/abis.js";
import type { Address, Deployment } from "./types.js";

/** What every read module needs: a viem public client and the addresses to read. */
export interface Context {
  client: PublicClient;
  deployment: Deployment;
}

/** Runs a viem read and turns any failure into a typed Trozu error. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = decodeRevert(e);
    // a missing token is a lookup miss, not a contract bug
    if (err.code === "REVERT" && (err as { errorName?: string }).errorName === "ERC721NonexistentToken") {
      throw new TrozuNotFoundError("That position does not exist.", { cause: e });
    }
    throw err;
  }
}

/** Accepts any well-formed address in any case, returns it checksummed. Throws a validation error otherwise. */
export function toAddress(name: string, value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new TrozuValidationError([`${name} is not a valid address`]);
  }
  return getAddress(value);
}

export function toUint(name: string, value: unknown, max = 2n ** 256n - 1n): bigint {
  let v: bigint;
  try {
    v = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : -1n;
  } catch {
    v = -1n;
  }
  if (v < 0n || v > max) throw new TrozuValidationError([`${name} is not a valid whole number in range`]);
  return v;
}

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** The vault behind a token id, straight from the NFT. Throws NotFound for a token that was never minted. */
export async function vaultOf({ client, deployment }: Context, tokenId: bigint): Promise<Address> {
  const v = await guarded(() => client.readContract({ address: deployment.trozu.nft, abi: nftAbi, functionName: "vaultOf", args: [tokenId] }));
  if (v === ZERO) throw new TrozuNotFoundError("That position does not exist.");
  return v;
}
