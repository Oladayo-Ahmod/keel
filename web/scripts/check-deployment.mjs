// Fails unless every address in src/config/deployment.v2.json has contract code on Mezo testnet
// (chain 31611). Run it before a deploy is announced or the Wave 2 flag is flipped.
//   node scripts/check-deployment.mjs
// Plain JSON-RPC over fetch, so it needs no dependencies.
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../src/config/deployment.v2.json", import.meta.url), "utf8"));
const rpc = process.env.RPC_URL ?? cfg.rpcUrl;

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Every address-shaped string in the config with its path, except the fee recipient (an EOA). */
function collect(node, path, out) {
  if (isAddress(node)) out.push([path, node]);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) collect(v, path ? `${path}.${k}` : k, out);
  return out;
}

async function call(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

const chainId = parseInt(await call("eth_chainId", []), 16);
if (chainId !== cfg.chainId) {
  console.error(`rpc is chain ${chainId}, config says ${cfg.chainId}`);
  process.exit(1);
}

const eoa = new Set(["market.feeRecipient"]);
let bad = 0;
for (const [path, addr] of collect(cfg, "", [])) {
  if (eoa.has(path)) continue;
  const code = await call("eth_getCode", [addr, "latest"]);
  const ok = code && code !== "0x";
  if (!ok) bad++;
  console.log(`${ok ? "ok     " : "NO CODE"} ${path.padEnd(28)} ${addr}${ok ? ` (${(code.length - 2) / 2} bytes)` : ""}`);
}
if (bad) {
  console.error(`${bad} address(es) have no code on chain ${chainId}`);
  process.exit(1);
}
console.log(`all addresses have code on chain ${chainId}`);
