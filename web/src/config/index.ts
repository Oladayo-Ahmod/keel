import deployment from "./deployment.json";

type Address = `0x${string}`;

// Every address the app uses comes from deployment.json, nothing is hardcoded in components.
export const config = {
  chainId: deployment.chainId,
  name: deployment.name,
  rpcUrl: deployment.rpcUrl,
  // tried in order; more endpoints can be added in deployment.json without touching code
  rpcUrls: [deployment.rpcUrl, ...(deployment.rpcFallbacks as string[])],
  explorer: deployment.explorer,
  keel: deployment.keel as Record<keyof typeof deployment.keel, Address>,
  mezo: deployment.mezo as Record<keyof typeof deployment.mezo, Address>,
} as const;

export const explorerAddress = (address: string) => `${config.explorer}/address/${address}`;
export const explorerTx = (hash: string) => `${config.explorer}/tx/${hash}`;

// Public WalletConnect project id. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to your own.
export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "keel-dev-placeholder";
