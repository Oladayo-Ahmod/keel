import { guarded, toAddress, type Context } from "./context.js";
import type { TrozuError } from "./errors.js";
import type { UnsignedTx } from "./types.js";

export type Simulation = { ok: true } | { ok: false; error: TrozuError };

/**
 * Dry-runs an unsigned transaction as `from` with an eth_call, using the gas limit the builder chose
 * (the node's estimateGas is not used, see gas.ts). Nothing is sent and nothing is signed. A revert
 * comes back as a typed error instead of being thrown, so a caller can show why it would fail.
 *
 * An eth_call is a hint, not a promise: state moves between the call and inclusion, and the node can
 * answer a call that the real block then refuses.
 */
export async function simulate({ client }: Context, tx: UnsignedTx, from: string): Promise<Simulation> {
  const account = toAddress("from", from);
  try {
    await guarded(() => client.call({ account, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e as TrozuError };
  }
}
