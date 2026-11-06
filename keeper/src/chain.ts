import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAbiItem,
  http,
  parseAbi,
  type Abi,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ChainApi, ChainRevert, Hex, Plan } from "./types.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface Config {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  deployedAtBlock: number;
  trozu: { factory: Hex; nft: Hex; lens: Hex; vaultImplementation: Hex; market: Hex };
  market: { feeBps: number; maxFeeBps: number; feeRecipient: Hex };
  mezo: Record<string, Hex> & { hintHelpers: Hex; sortedTroves: Hex; troveManager: Hex };
  abi: Record<string, string>;
}

export function loadConfig(path = resolve(REPO_ROOT, "web/src/config/deployment.v2.json")): Config {
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

export function loadAbi(cfg: Config, name: "factory" | "nft" | "vault" | "market" | "lens"): Abi {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, cfg.abi[name]), "utf8")) as Abi;
}

/// A key from the environment, with or without 0x, and tolerant of a stray CR from a Windows .env.
export function keyFromEnv(name: string): Hex | undefined {
  const raw = (process.env[name] ?? "").replace(/[\s\r\n]/g, "");
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export function makeChain(cfg: Config, rpcUrl = cfg.rpcUrl) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function makeClients(cfg: Config, privateKey?: Hex, rpcUrl?: string) {
  const chain = makeChain(cfg, rpcUrl);
  // the public RPC drops a few percent of connections, so retry at the transport too
  const transport = http(rpcUrl ?? cfg.rpcUrl, { retryCount: 4, retryDelay: 800, timeout: 30_000 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account: Account | undefined = privateKey ? privateKeyToAccount(privateKey) : undefined;
  const walletClient = account ? (createWalletClient({ chain, transport, account }) as WalletClient) : undefined;
  return { publicClient, walletClient, account, chain };
}

/// Turn a viem failure into ChainRevert when the node said the call reverts, and leave anything
/// else (a dropped connection, a timeout) as a transient error.
export function asRevert(e: unknown): unknown {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) {
      const name = reverted.data?.errorName;
      const args = reverted.data?.args?.map(String).join(",");
      return new ChainRevert(name ? `${name}${args ? `(${args})` : ""}` : reverted.reason ?? "execution reverted");
    }
    if (e.walk((x) => (x as Error).name === "ExecutionRevertedError")) return new ChainRevert("execution reverted");
  }
  return e;
}

/// The real chain, over viem.
export function realChain(cfg: Config, publicClient: PublicClient, walletClient?: WalletClient): ChainApi {
  const factoryAbi = loadAbi(cfg, "factory");
  const vaultAbi = loadAbi(cfg, "vault");
  const created = getAbiItem({ abi: factoryAbi, name: "PositionCreated" });
  const policySet = getAbiItem({ abi: vaultAbi, name: "PolicySet" });
  const account = walletClient?.account;

  return {
    head: () => publicClient.getBlockNumber(),

    async createdVaults(from, to) {
      const logs = await publicClient.getLogs({
        address: cfg.trozu.factory,
        event: created as never,
        fromBlock: from,
        toBlock: to,
      });
      return logs.map((l) => (l as unknown as { args: { vault: Hex } }).args.vault);
    },

    async policyEmitters(from, to) {
      const logs = await publicClient.getLogs({ event: policySet as never, fromBlock: from, toBlock: to });
      return logs.map((l) => (l as unknown as { address: Hex }).address);
    },

    policyLive: (vault) =>
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "policyLive" }) as Promise<boolean>,

    async preview(vault): Promise<Plan> {
      const p = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "preview" })) as {
        kind: number;
        reason: number;
        amount: bigint;
        tip: bigint;
        icr: bigint;
        resetWindow: boolean;
      };
      return { ...p, kind: Number(p.kind), reason: Number(p.reason) };
    },

    async hints(vault, plan) {
      const tm = parseAbi(["function getEntireDebtAndColl(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
      const [coll, principal, interest] = (await publicClient.readContract({ address: cfg.mezo.troveManager, abi: tm, functionName: "getEntireDebtAndColl", args: [vault] })) as readonly bigint[];
      const debt = principal + interest;
      // TopUpBtc and DefendBtc add collateral, RepayMusd removes debt; the list is keyed by coll * 1e20 / debt
      const [newColl, newDebt] = plan.kind === 2 ? [coll, debt - plan.amount] : [coll + plan.amount, debt];
      const nicr = (newColl * 10n ** 20n) / newDebt;
      const [approx] = (await publicClient.readContract({
        address: cfg.mezo.hintHelpers,
        abi: parseAbi(["function getApproxHint(uint256,uint256,uint256) view returns (address,uint256,uint256)"]),
        functionName: "getApproxHint",
        args: [nicr, 50n, BigInt(Math.floor(Math.random() * 1_000_000))],
      })) as readonly [Hex, bigint, bigint];
      const [upper, lower] = (await publicClient.readContract({
        address: cfg.mezo.sortedTroves,
        abi: parseAbi(["function findInsertPosition(uint256,address,address) view returns (address,address)"]),
        functionName: "findInsertPosition",
        args: [nicr, approx, approx],
      })) as readonly [Hex, Hex];
      return [upper, lower] as const;
    },

    async estimateExecute(vault, hints) {
      try {
        return await publicClient.estimateContractGas({
          address: vault,
          abi: vaultAbi,
          functionName: "execute",
          args: [hints?.[0] ?? "0x0000000000000000000000000000000000000000", hints?.[1] ?? "0x0000000000000000000000000000000000000000"],
          account: account ?? "0x0000000000000000000000000000000000000001",
        });
      } catch (e) {
        throw asRevert(e);
      }
    },

    async sendExecute(vault, gas, hints) {
      if (!walletClient || !account) throw new Error("no keeper account: set KEEPER_PRIVATE_KEY");
      const hash = await walletClient.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "execute",
        args: [hints?.[0] ?? "0x0000000000000000000000000000000000000000", hints?.[1] ?? "0x0000000000000000000000000000000000000000"],
        gas,
        account,
        chain: walletClient.chain,
      });
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return { hash, status: r.status, gasUsed: r.gasUsed };
    },
  };
}
