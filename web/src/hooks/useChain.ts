"use client";

import { useQuery } from "@tanstack/react-query";
import { borrowerOperationsAbi, priceFeedAbi } from "@/abi/mezo";
import { config } from "@/config";
import type { Freshness } from "@/lib/freshness";
import { currentFreshness, freshRead } from "@/lib/rpc";

/** Head of whichever node answered, judged against the newest block seen. Polled for the header pill. */
export function useChainHead(): { freshness?: Freshness; error: boolean } {
  const q = useQuery({
    queryKey: ["head"],
    queryFn: currentFreshness,
    refetchInterval: 12_000,
    retry: 1,
  });
  return { freshness: q.data, error: q.isError };
}

export interface OpenInputs {
  price: bigint;
  minNetDebt: bigint;
  fee: bigint | undefined;
  balance: bigint | undefined;
}

/** Everything the open form needs from the chain, read together and checked for staleness. */
export function useOpenInputs(address: `0x${string}` | undefined, debt: bigint | undefined) {
  return useQuery({
    queryKey: ["open-inputs", address, debt?.toString()],
    queryFn: async () => {
      const r = await freshRead(async (c) => {
        const [price, minNetDebt, fee, balance] = await Promise.all([
          c.readContract({ address: config.mezo.priceFeed, abi: priceFeedAbi, functionName: "fetchPrice" }),
          c.readContract({ address: config.mezo.borrowerOperations, abi: borrowerOperationsAbi, functionName: "minNetDebt" }),
          debt
            ? c.readContract({ address: config.mezo.borrowerOperations, abi: borrowerOperationsAbi, functionName: "getBorrowingFee", args: [debt] })
            : Promise.resolve(undefined),
          address ? c.getBalance({ address }) : Promise.resolve(undefined),
        ]);
        return { price, minNetDebt, fee, balance } as OpenInputs;
      });
      return r;
    },
    refetchInterval: 15_000,
    retry: 1,
  });
}
