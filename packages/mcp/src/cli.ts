#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTrozu } from "@trozu/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { createServer } from "./server.js";

// The only setting is the RPC endpoint. There is no key, no account and no signer to configure.
const base = createTrozu();
const rpc = process.env.TROZU_RPC_URL;
const trozu = rpc
  ? createTrozu({ client: createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 20_000 }) }) as PublicClient })
  : base;

const server = createServer(trozu);
await server.connect(new StdioServerTransport());
// stdout carries the protocol, so anything for a human goes to stderr
console.error(`trozu-mcp ready on ${trozu.deployment.name} (chain ${trozu.deployment.chainId}), read-only, no keys`);
