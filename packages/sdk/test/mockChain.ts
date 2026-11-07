import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  toHex,
  type Abi,
  type PublicClient,
} from "viem";
import { lensAbi, marketAbi, nftAbi, vaultAbi } from "../src/generated/abis.js";
import { matsnet } from "../src/client.js";
import type { Address, Deployment, Hex, Listing } from "../src/types.js";

/** Throw from an implementation to make the mock chain revert with a custom error. */
export class Revert extends Error {
  constructor(public abi: Abi, public errorName: string, public args: unknown[] = []) {
    super(`revert ${errorName}`);
  }
}

type Impl = Record<string, (args: readonly unknown[]) => unknown>;

export interface MockChain {
  client: PublicClient;
  deployment: Deployment;
  /** Every JSON-RPC request the code under test made, in order. */
  requests: { method: string; params: unknown }[];
  state: { block: bigint; timestamp: bigint; logs: MockLog[] };
  /** Registers (or replaces) the implementation of a contract. */
  contract(address: Address, abi: Abi, impl: Impl): void;
}

export interface MockLog {
  address: Address;
  blockNumber: bigint;
  topics: Hex[];
  data: Hex;
  txHash: Hex;
}

const lower = (a: string) => a.toLowerCase();

export function mockChain(deployment: Deployment = matsnet): MockChain {
  const contracts = new Map<string, { abi: Abi; impl: Impl }>();
  const requests: MockChain["requests"] = [];
  const state: MockChain["state"] = { block: 16_700_000n, timestamp: 1_800_000_000n, logs: [] };

  const rpc = async ({ method, params }: { method: string; params?: unknown }) => {
    requests.push({ method, params });
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return toHex(deployment.chainId);
      case "eth_blockNumber":
        return toHex(state.block);
      case "eth_getBlockByNumber":
        return {
          number: toHex(state.block),
          hash: "0x" + "11".repeat(32),
          parentHash: "0x" + "22".repeat(32),
          timestamp: toHex(state.timestamp),
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          gasLimit: toHex(10_000_000n),
          gasUsed: "0x0",
          miner: "0x" + "00".repeat(20),
          extraData: "0x",
          logsBloom: "0x" + "00".repeat(256),
          mixHash: "0x" + "00".repeat(32),
          receiptsRoot: "0x" + "00".repeat(32),
          sha3Uncles: "0x" + "00".repeat(32),
          stateRoot: "0x" + "00".repeat(32),
          transactionsRoot: "0x" + "00".repeat(32),
          size: "0x0",
          transactions: [],
          uncles: [],
        };
      case "eth_getLogs": {
        const f = p[0] as { address?: string; fromBlock: Hex; toBlock: Hex; topics?: (Hex | null)[] };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        return state.logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
          .filter((l) => !f.address || lower(f.address) === lower(l.address))
          .filter((l) => (f.topics ?? []).every((t, i) => t === null || t === undefined || l.topics[i] === t))
          .map((l, i) => ({
            address: l.address,
            blockNumber: toHex(l.blockNumber),
            blockHash: "0x" + "33".repeat(32),
            transactionHash: l.txHash,
            transactionIndex: "0x0",
            logIndex: toHex(i),
            topics: l.topics,
            data: l.data,
            removed: false,
          }));
      }
      case "eth_call": {
        const call = p[0] as { to: string; data: Hex };
        const c = contracts.get(lower(call.to));
        if (!c) throw rpcError(`no mock contract at ${call.to}`);
        const { functionName, args } = decodeFunctionData({ abi: c.abi, data: call.data });
        const fn = c.impl[functionName];
        if (!fn) throw rpcError(`no mock for ${functionName}`);
        try {
          const result = fn((args ?? []) as readonly unknown[]);
          return encodeFunctionResult({ abi: c.abi, functionName, result } as never);
        } catch (e) {
          if (e instanceof Revert) {
            const data = encodeErrorResult({ abi: e.abi, errorName: e.errorName, args: e.args } as never);
            throw Object.assign(new Error("execution reverted"), { code: 3, data });
          }
          throw e;
        }
      }
      default:
        throw rpcError(`unmocked method ${method}`);
    }
  };

  const client = createPublicClient({ transport: custom({ request: rpc as never }, { retryCount: 0 }) }) as PublicClient;
  return {
    client,
    deployment,
    requests,
    state,
    contract: (address, abi, impl) => void contracts.set(lower(address), { abi, impl }),
  };
}

function rpcError(message: string) {
  return Object.assign(new Error(message), { code: -32000 });
}

/** A ListingAnnounced log as the market would emit it. */
export function announceLog(market: Address, hash: Hex, l: Listing, signature: Hex, blockNumber: bigint): MockLog {
  const event = getAbiItem({ abi: marketAbi, name: "ListingAnnounced" });
  const topics = encodeEventTopics({ abi: [event], eventName: "ListingAnnounced", args: { hash, seller: l.seller, tokenId: l.tokenId } } as never) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "tuple", components: (event.inputs.find((i) => i.name === "listing") as unknown as { components: never[] }).components },
      { type: "bytes" },
    ] as never,
    [l, signature] as never,
  );
  return { address: market, blockNumber, topics, data, txHash: ("0x" + blockNumber.toString(16).padStart(64, "0")) as Hex };
}

export const ABIS = { lensAbi, marketAbi, nftAbi, vaultAbi } as const;

export const ADDR = {
  alice: "0x1111111111111111111111111111111111111111" as Address,
  bob: "0x2222222222222222222222222222222222222222" as Address,
  vault: "0x3333333333333333333333333333333333333333" as Address,
};

export const sampleListing = (over: Partial<Listing> = {}): Listing => ({
  seller: ADDR.alice,
  tokenId: 7n,
  epoch: 1n,
  startPrice: 1_000n * 10n ** 18n,
  endPrice: 800n * 10n ** 18n,
  startTime: 1_799_999_000n,
  endTime: 1_800_001_000n,
  deadline: 1_800_100_000n,
  nonce: 0n,
  salt: 5n,
  ...over,
});
