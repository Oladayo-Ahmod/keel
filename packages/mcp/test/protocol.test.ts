import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, INSTRUCTIONS } from "../src/server.js";
import { ADDR, fixture } from "./fixture.js";

async function connect() {
  const f = fixture();
  const server = createServer(f.trozu);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { ...f, client };
}

describe("the server over the MCP protocol", () => {
  it("offers exactly the six documented tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["build_tx", "get_position", "guardian_status", "list_listings", "quote_listing", "simulate_action"]);
  });

  it("takes no key, signature or raw transaction in any tool's arguments", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const forbidden = /private|secret|mnemonic|seed|signature|signed|rawtx|keystore|password|passphrase/i;
    for (const t of tools) {
      for (const name of Object.keys((t.inputSchema as { properties?: object }).properties ?? {})) expect(name, `${t.name}.${name}`).not.toMatch(forbidden);
    }
  });

  it("marks every tool read-only, since none of them sends anything", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it("tells the model the chain is untrusted and that nothing here signs", () => {
    expect(INSTRUCTIONS).toMatch(/cannot sign or send/);
    expect(INSTRUCTIONS).toMatch(/untrusted/);
  });

  it("answers a tool call end to end", async () => {
    const { client } = await connect();
    const r = (await client.callTool({ name: "get_position", arguments: { tokenId: "7" } })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text);
    expect(out.position.vault).toBe(ADDR.vault);
    expect(out.note).toMatch(/untrusted/);
  });

  it("returns a tool error, not a protocol error, for bad arguments", async () => {
    const { client } = await connect();
    const r = (await client.callTool({ name: "build_tx", arguments: { action: "add_collateral", tokenId: "7", amount: "-5" } })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error.code).toBe("VALIDATION");
  });

  it("refuses an unknown action before the handler runs", async () => {
    const { client, m } = await connect();
    const r = (await client.callTool({ name: "build_tx", arguments: { action: "send_funds" } })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid/);
    expect(m.requests).toHaveLength(0);
  });
});
