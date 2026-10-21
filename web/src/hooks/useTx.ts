"use client";

import { useCallback, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import type { TransactionReceipt } from "viem";
import { friendlyError } from "@/lib/errors";

export type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "pending"; hash: `0x${string}` }
  | { status: "success"; hash: `0x${string}`; receipt: TransactionReceipt }
  | { status: "failed"; hash?: `0x${string}`; message: string; rejected: boolean };

// The call sites pass const-typed objects; wagmi's own parameter type is a large union that
// rejects payable calls with a value, so this keeps the shape loose and casts once below.
interface WriteParams {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  chainId?: number;
}

/**
 * One transaction from wallet prompt to receipt: signing, pending, success or
 * failed. A failure after the hash exists keeps the hash, because the
 * transaction may still land.
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const reset = useCallback(() => setState({ status: "idle" }), []);

  const send = useCallback(
    async (params: WriteParams): Promise<TransactionReceipt | undefined> => {
      setState({ status: "signing" });
      let hash: `0x${string}`;
      try {
        hash = await writeContractAsync(params as unknown as Parameters<typeof writeContractAsync>[0]);
      } catch (e) {
        const f = friendlyError(e);
        setState({ status: "failed", message: f.message, rejected: f.rejected });
        return undefined;
      }
      setState({ status: "pending", hash });
      try {
        const receipt = await client!.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status === "success") {
          setState({ status: "success", hash, receipt });
          return receipt;
        }
        setState({ status: "failed", hash, message: "The transaction was mined but reverted.", rejected: false });
      } catch (e) {
        const f = friendlyError(e);
        setState({
          status: "failed",
          hash,
          message: `Could not confirm the transaction yet (${f.message}). It may still go through, check the explorer.`,
          rejected: false,
        });
      }
      return undefined;
    },
    [client, writeContractAsync],
  );

  return { state, send, reset, busy: state.status === "signing" || state.status === "pending" };
}
