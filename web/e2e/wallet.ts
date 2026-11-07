// TEST ONLY. The "wallet" behind src/e2e/config.ts: a burner key from the environment (never
// printed), signing on the runner side. Records every transaction the page asks for, with the gas
// limit the app asked for, so the run can check it against what was actually used.
import { createPublicClient, createWalletClient, http, toFunctionSelector, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Page } from "playwright-core";
import deployment from "../src/config/deployment.v2.json";
import { positionFactoryAbi, positionNFTAbi, positionVaultAbi } from "../src/abi/keel";
import { erc20Abi } from "../src/abi/mezo";
import { trozuFactoryAbi, trozuMarketAbi, trozuNFTAbi, trozuVaultAbi } from "../src/abi/trozu";

export const chain = {
  id: deployment.chainId,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
} as const;

export const publicClient = createPublicClient({ chain, transport: http(deployment.rpcUrl, { retryCount: 4, retryDelay: 800 }) });

const selectors = new Map<string, string>();
for (const abi of [trozuVaultAbi, trozuMarketAbi, trozuFactoryAbi, trozuNFTAbi, positionVaultAbi, positionNFTAbi, positionFactoryAbi, erc20Abi] as Abi[]) {
  for (const item of abi) if (item.type === "function") selectors.set(toFunctionSelector(item), item.name);
}

export interface TxRecord {
  who: string;
  fn: string;
  to: Hex;
  gasLimit?: bigint;
  value: bigint;
  hash?: Hex;
  error?: string;
}

export function keyOf(name: string): Hex {
  const k = process.env[name];
  if (!k) throw new Error(`${name} is not set`);
  return (k.startsWith("0x") ? k : `0x${k}`) as Hex;
}

/** Make `page` talk to a burner wallet. Returns its address and the log of what it was asked to send. */
export async function attachWallet(page: Page, who: string, key: Hex, opts: { failSends?: () => boolean } = {}) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(deployment.rpcUrl, { retryCount: 3, retryDelay: 800 }) });
  const log: TxRecord[] = [];
  const ctl = { rejectNext: false };
  const num = (h: unknown) => (typeof h === "string" ? BigInt(h) : undefined);

  /** The public node drops requests now and then. Retry only while the account's nonce has not moved, so a send is never doubled. */
  const sendOnce = async (t: { to: Hex; data?: Hex }, rec: TxRecord): Promise<Hex> => {
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await wallet.sendTransaction({ to: t.to, data: t.data, value: rec.value || undefined, gas: rec.gasLimit, nonce });
      } catch (e) {
        last = e;
        const msg = e instanceof Error ? e.message : "";
        if (!/HTTP request failed|fetch failed|timed out/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        const now = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }).catch(() => nonce);
        if (now !== nonce) throw e; // it may have landed; do not send again
      }
    }
    throw last;
  };

  await page.exposeFunction("__e2eRequest", async (r: { method: string; params?: unknown[] }) => {
    const p = r.params ?? [];
    switch (r.method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "eth_chainId":
        return `0x${chain.id.toString(16)}`;
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction": {
        const t = p[0] as { to: Hex; data?: Hex; value?: string; gas?: string };
        const rec: TxRecord = { who, fn: selectors.get((t.data ?? "0x").slice(0, 10)) ?? (t.data ?? "0x").slice(0, 10), to: t.to, gasLimit: num(t.gas), value: num(t.value) ?? 0n };
        log.push(rec);
        if (ctl.rejectNext) {
          ctl.rejectNext = false;
          rec.error = "rejected in the wallet";
          throw new Error("E2E_CODE:4001:User rejected the request.");
        }
        try {
          rec.hash = await sendOnce(t, rec);
          return rec.hash;
        } catch (e) {
          rec.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
          throw e;
        }
      }
      case "eth_signTypedData_v4": {
        const td = JSON.parse(p[1] as string) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
        const { EIP712Domain: _d, ...types } = td.types;
        const fix = (typeName: string, v: Record<string, unknown>) => {
          const out: Record<string, unknown> = {};
          for (const f of types[typeName]) {
            const x = v[f.name];
            out[f.name] = /^u?int/.test(f.type) && (typeof x === "string" || typeof x === "number") ? BigInt(x) : x;
          }
          return out;
        };
        const domain = { ...td.domain, chainId: td.domain.chainId !== undefined ? BigInt(td.domain.chainId as string | number) : undefined };
        return account.signTypedData({ domain, types, primaryType: td.primaryType, message: fix(td.primaryType, td.message) } as never);
      }
      default: {
        // reads and anything else go straight to the node
        const res = await fetch(deployment.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: r.method, params: p }) });
        const body = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (body.error) throw new Error(body.error.message);
        return body.result;
      }
    }
  });
  return { account, address: account.address, log, ctl };
}
