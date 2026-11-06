"use client";

import { useQuery } from "@tanstack/react-query";
import { borrowerOperationsAbi, erc20Abi, permitAbi } from "@/abi/mezo";
import { config } from "@/config";
import type { Freshness } from "@/lib/freshness";
import { freshRead } from "@/lib/rpc";

export interface Preflight {
  btc: bigint;
  musd: bigint;
  allowance: bigint;
  minNetDebt: bigint;
  /** Fee Mezo would charge on `feeFor`, when an amount was given. */
  fee: bigint | undefined;
  /** Funds sitting in the vault outside the trove. */
  vaultBtc: bigint;
  vaultMusd: bigint;
  permit: { name: string; nonce: bigint; separator: `0x${string}` };
}

/**
 * Wallet and vault facts the action forms check against, read together with a head block so a
 * lagging node is noticed. Refreshed often, since a stale balance would make a check lie.
 */
export function usePreflight(vault: `0x${string}`, owner: `0x${string}` | undefined, feeFor: bigint | undefined) {
  return useQuery({
    queryKey: ["preflight", vault, owner, feeFor?.toString()],
    enabled: !!owner,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async (): Promise<{ data: Preflight; freshness: Freshness }> => {
      const musd = config.mezo.musd;
      return freshRead(async (c) => {
        const [btc, musdBal, allowance, minNetDebt, fee, vaultBtc, vaultMusd, name, nonce, separator] = await Promise.all([
          c.getBalance({ address: owner! }),
          c.readContract({ address: musd, abi: erc20Abi, functionName: "balanceOf", args: [owner!] }),
          c.readContract({ address: musd, abi: erc20Abi, functionName: "allowance", args: [owner!, vault] }),
          c.readContract({ address: config.mezo.borrowerOperations, abi: borrowerOperationsAbi, functionName: "minNetDebt" }),
          feeFor
            ? c.readContract({ address: config.mezo.borrowerOperations, abi: borrowerOperationsAbi, functionName: "getBorrowingFee", args: [feeFor] })
            : Promise.resolve(undefined),
          c.getBalance({ address: vault }),
          c.readContract({ address: musd, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
          c.readContract({ address: musd, abi: permitAbi, functionName: "name" }),
          c.readContract({ address: musd, abi: permitAbi, functionName: "nonces", args: [owner!] }),
          c.readContract({ address: musd, abi: permitAbi, functionName: "DOMAIN_SEPARATOR" }),
        ]);
        return { btc, musd: musdBal, allowance, minNetDebt, fee, vaultBtc, vaultMusd, permit: { name, nonce, separator } };
      });
    },
  });
}
