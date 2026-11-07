import { createPublicClient, http, type PublicClient } from "viem";
import { vaultOf as vaultOfNft, type Context } from "./context.js";
import { matsnetDeployment } from "./generated/deployment.js";
import { guardianReads } from "./guardian.js";
import { computeHints } from "./hints.js";
import { lensReads } from "./lens.js";
import { marketReads } from "./market.js";
import { simulate } from "./simulate.js";
import { txBuilders } from "./tx.js";
import type { Deployment, UnsignedTx } from "./types.js";

/** The Mezo testnet (matsnet) deployment this package was built against. */
export const matsnet: Deployment = matsnetDeployment;

export interface TrozuOptions {
  /** Any viem public client for the deployment's chain. Default: one over the deployment's public RPC. */
  client?: PublicClient;
  /** Default: matsnet. */
  deployment?: Deployment;
}

/**
 * The one entry point. Reads (`lens`, `market`, `guardian`) go to the chain through the client; `tx`
 * only builds unsigned transactions and never touches the network.
 *
 *     const trozu = createTrozu();
 *     const p = await trozu.lens.position(1n);
 */
export function createTrozu(o: TrozuOptions = {}) {
  const deployment = o.deployment ?? matsnet;
  const client = o.client ?? (createPublicClient({ transport: http(deployment.rpcUrl) }) as PublicClient);
  const ctx: Context = { client, deployment };
  return {
    deployment,
    lens: lensReads(ctx),
    market: marketReads(ctx),
    guardian: guardianReads(ctx),
    tx: txBuilders(deployment),
    /** Dry-runs an unsigned transaction as `from` with an eth_call. Sends nothing. */
    simulate: (tx: UnsignedTx, from: string) => simulate(ctx, tx, from),
    /** The vault behind a position id, from the NFT. */
    vaultOf: (tokenId: bigint) => vaultOfNft(ctx, tokenId),
    /** Sorted-list hints for a trove with this NICR, to cut gas on any call that moves it. */
    hints: (nicr: bigint, seed?: bigint) => computeHints(ctx, nicr, seed),
  };
}

export type Trozu = ReturnType<typeof createTrozu>;
