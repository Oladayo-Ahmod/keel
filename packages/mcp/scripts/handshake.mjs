// Proves the client config snippet in README.md works: reads examples/claude_desktop_config.json, swaps the
// placeholder path for this checkout, starts the server exactly as that config says, and does a full MCP
// handshake with the SDK's own stdio client: initialize, tools/list, then a real get_position call.
//
//   npm run build && npm run handshake -w @trozu/mcp         (reads matsnet, sends nothing)
//
// Exits 1 on any failure. It proves the command speaks MCP over stdio; it does not prove that Claude Desktop
// or Claude Code accepts the config, because neither is started here.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const keelRoot = resolve(here, "..", "..", "..");
const config = JSON.parse(readFileSync(join(here, "..", "examples", "claude_desktop_config.json"), "utf8"));
const entry = config.mcpServers.trozu;
const args = entry.args.map((a) => a.replace("/path/to/keel", keelRoot));

const fail = (msg) => {
  console.error(`handshake FAILED: ${msg}`);
  process.exit(1);
};

const transport = new StdioClientTransport({ command: entry.command, args, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", (d) => (stderr += d));

const client = new Client({ name: "handshake-check", version: "0.0.0" });
try {
  await client.connect(transport); // sends initialize and the initialized notification
  const server = client.getServerVersion();
  console.log(`initialize ok: server "${server?.name}" ${server?.version}, protocol ${client.getServerCapabilities() ? "capabilities received" : "no capabilities"}`);
  if (server?.name !== "trozu") fail(`unexpected server name ${server?.name}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`tools/list ok: ${names.join(", ")}`);
  const want = ["build_tx", "get_position", "guardian_status", "list_listings", "quote_listing", "simulate_action"];
  if (JSON.stringify(names) !== JSON.stringify(want)) fail(`expected ${want.join(", ")}`);

  const res = await client.callTool({ name: "get_position", arguments: { tokenId: "1" } });
  if (res.isError) fail(`get_position returned an error: ${res.content?.[0]?.text}`);
  const out = JSON.parse(res.content[0].text);
  const p = out.position;
  console.log(`tools/call get_position ok: position #${p.tokenId}, vault ${p.vault}, risk ${p.risk}, ratio ${p.icrPercent}%, collateral ${p.collateralBtc} BTC, debt ${p.debtMusd} MUSD`);
  if (p.tokenId !== "1" || !/^0x[0-9a-fA-F]{40}$/.test(p.vault)) fail("the position did not look right");
  console.log("handshake ok");
} catch (e) {
  fail(`${e?.message ?? e}${stderr ? `\nserver stderr: ${stderr.trim()}` : ""}`);
} finally {
  await client.close().catch(() => {});
}
console.log(`server said on stderr: ${stderr.trim()}`);
