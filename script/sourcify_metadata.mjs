// Submits each Trozu contract to Sourcify with the exact metadata.json the build wrote (rawMetadata) and every source it lists,
// then reads back the match level. Nothing is signed or sent on chain. Needs `forge build` first and Node 22.
//   node script/sourcify_metadata.mjs
// Why this and not `forge verify-contract`: on 2026-11-07 that command's submission left all five at `match` (the source
// reproduces the bytecode but Sourcify did not accept the metadata hash). The metadata the build writes hashes to exactly the
// hash embedded in each deployed bytecode (checked first), and submitting it this way gave `exact_match` for all five.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..") + "/";
const API = "https://sourcify.dev/server";
const CHAIN = 31611;
const targets = [
  ["TrozuFactory", "src/v2/TrozuFactory.sol", "0x70791379537cB14981AA7114678663164141eC31", "0xe7bae178b3cb667d81aeb941ae717f0465b93abd43269c18295ae9f791b6903a"],
  ["TrozuNFT", "src/v2/TrozuNFT.sol", "0xd53f649e4df31351De8935De9cA7110888F055b8"],
  ["PositionLens", "src/PositionLens.sol", "0xCCF8c5aFe7473eC41F64906071e1bE497872004C"],
  ["TrozuVault", "src/v2/TrozuVault.sol", "0x6ef4395325828083672FFe836d6Bc80Bf22cACFE"],
  ["TrozuMarket", "src/v2/TrozuMarket.sol", "0xEae6fEa26B178eF32829F36e5219363bB30D93DB", "0xd4643026ede31329f68538261b9ff274a7b185e31acbf5422630189d9908a37a"],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => { const r = await fetch(API + path); return { status: r.status, body: await r.json().catch(() => ({})) }; };

for (const [name, file, addr, creationTx] of targets) {
  const art = JSON.parse(readFileSync(`${root}out/${file.split("/").pop()}/${name}.json`, "utf8"));
  const metadata = JSON.parse(art.rawMetadata);
  const sources = {};
  for (const path of Object.keys(metadata.sources)) sources[path] = readFileSync(root + path, "utf8");
  const body = { sources, metadata, ...(creationTx ? { creationTransactionHash: creationTx } : {}) };
  const res = await fetch(`${API}/v2/verify/metadata/${CHAIN}/${addr}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.log(name.padEnd(13), "submit refused", res.status, JSON.stringify(out).slice(0, 300)); continue; }
  const id = out.verificationId;
  let job;
  for (let i = 0; i < 30; i++) {
    await sleep(2500);
    job = (await get(`/v2/verify/${id}`)).body;
    if (job.isJobCompleted) break;
  }
  const c = (await get(`/v2/contract/${CHAIN}/${addr}`)).body;
  console.log(name.padEnd(13), "job", job?.isJobCompleted ? "done" : "pending", "| error:", job?.error ? JSON.stringify(job.error).slice(0, 160) : "none", "| now:", `match=${c.match} runtime=${c.runtimeMatch} creation=${c.creationMatch ?? "-"}`);
}
