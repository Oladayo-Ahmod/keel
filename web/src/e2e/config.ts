// TEST ONLY. Loaded by providers.tsx behind NEXT_PUBLIC_E2E === "1", which the production build
// never sets, so none of this is in what ships (scripts/check-no-e2e.mjs checks the build output).
//
// A wagmi connector whose "wallet" is a function the test runner exposes on the page
// (window.__e2eRequest). The runner holds a burner key from .env and signs there; the key never
// enters the page or the bundle. Everything the app does (useTx, signTypedData, chain switches)
// goes through the normal wagmi code path, so the UI is exercised for real.
import { createConfig, createConnector } from "wagmi";
import { connect } from "wagmi/actions";
import { mezoTestnet } from "@mezo-org/passport";
import { makeTransport } from "@/lib/rpc";

type Request = { method: string; params?: unknown[] };
const rawCall = (r: Request): Promise<unknown> => {
  const fn = (window as unknown as { __e2eRequest?: (r: Request) => Promise<unknown> }).__e2eRequest;
  if (!fn) throw new Error("no __e2eRequest on the page; run through the e2e driver");
  return fn(r);
};

// the runner reports a wallet error code as "E2E_CODE:<code>:<message>", because only the message survives the bridge
const call = async (r: Request): Promise<unknown> => {
  try {
    return await rawCall(r);
  } catch (e) {
    const m = /E2E_CODE:(-?\d+):(.*)/s.exec(e instanceof Error ? e.message : String(e));
    if (m) throw Object.assign(new Error(m[2]), { code: Number(m[1]) });
    throw e;
  }
};

const e2eConnector = createConnector(() => ({
  id: "e2e",
  name: "E2E burner",
  type: "e2e",
  async setup() {},
  async connect() {
    const accounts = (await call({ method: "eth_accounts" })) as `0x${string}`[];
    return { accounts, chainId: mezoTestnet.id } as never;
  },
  async disconnect() {},
  async getAccounts() {
    return (await call({ method: "eth_accounts" })) as `0x${string}`[];
  },
  async getChainId() {
    return Number(await call({ method: "eth_chainId" }));
  },
  async getProvider() {
    return { request: (r: Request) => call(r) };
  },
  async isAuthorized() {
    return true;
  },
  onAccountsChanged() {},
  onChainChanged() {},
  onDisconnect() {},
}));

export const e2eWagmiConfig = createConfig({
  chains: [mezoTestnet],
  connectors: [e2eConnector],
  transports: { [mezoTestnet.id]: makeTransport() },
  ssr: true,
});

if (typeof window !== "undefined") {
  // connect as soon as the driver has exposed its function
  const tryConnect = () => {
    if ((window as unknown as { __e2eRequest?: unknown }).__e2eRequest) void connect(e2eWagmiConfig as never, { connector: e2eWagmiConfig.connectors[0] } as never);
    else setTimeout(tryConnect, 100);
  };
  tryConnect();
}
