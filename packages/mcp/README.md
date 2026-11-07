# @trozu/mcp

An [MCP](https://modelcontextprotocol.io) server over [`@trozu/sdk`](../sdk). It lets an AI client read Trozu
positions, the market and the guardian on the Mezo testnet, and prepare transactions. It **cannot sign or
send anything and holds no key**: the most it ever returns is unsigned calldata for the user to review and
sign in their own wallet.

## Run it

```sh
cd packages && npm install && npm run build
node mcp/dist/cli.js            # speaks MCP over stdio
```

The only setting is `TROZU_RPC_URL` (default: the public Mezo testnet RPC). There is no key, account or
signer setting, and the code reads no other environment variable.

## Connect a client

Build first (`npm run build` in `packages/`), then replace `/path/to/keel` with the absolute path of your
checkout. Use an absolute path: clients start the command from their own working directory.

**Claude Desktop.** Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config), then restart
the app:

```json
{
  "mcpServers": {
    "trozu": {
      "command": "node",
      "args": ["/path/to/keel/packages/mcp/dist/cli.js"]
    }
  }
}
```

**Claude Code.** One command (add `--scope user` to have it in every project):

```sh
claude mcp add trozu -- node /path/to/keel/packages/mcp/dist/cli.js
```

or commit the same JSON as `.mcp.json` at the root of a project. To use a different RPC, add
`-e TROZU_RPC_URL=<your rpc url>` before the name (`claude mcp add -e TROZU_RPC_URL=... trozu -- node ...`), or an
`"env": { "TROZU_RPC_URL": "..." }` entry in the JSON. `claude mcp list` shows whether it connected.

The JSON above is also kept as [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

**What has been checked.** `npm run handshake -w @trozu/mcp` reads that example file, starts the server with
exactly its `command` and `args`, and runs a full handshake with the MCP SDK's own stdio client:
`initialize`, `tools/list`, then a real `get_position` call for position 1 on matsnet. It passed on
2026-11-07:

```
initialize ok: server "trozu" 0.1.0
tools/list ok: build_tx, get_position, guardian_status, list_listings, quote_listing, simulate_action
tools/call get_position ok: position #1, vault 0x2B08...9AB9, risk safe, ratio 162.81%, ...
handshake ok
```

That shows the command speaks MCP over stdio. It does **not** show that Claude Desktop or Claude Code loads it:
neither app was started, and I did not run `claude mcp add` or `claude mcp list`. The Claude Code command and
the Claude Desktop path are from their documentation, not from a run.

## Tools

| Tool | What it does | Main arguments |
|---|---|---|
| `get_position` | One position (or the positions a wallet holds): collateral, debt, ratio, equity, risk, locked rate against market rate, and optionally the redemption buffer against a threshold with a verdict | `tokenId` or `holder`; `bufferThresholdMusd` |
| `list_listings` | Positions announced for sale, newest first, each checked by the market contract: open or not, price now, fee. Max 25 | `tokenId`, `onlyOpen`, `limit`, `lookbackBlocks` |
| `quote_listing` | One listing priced now, with the bounds a careful buyer would sign (the sale reverts, spending nothing, if the position moves first) | `listingHash` or `tokenId` |
| `guardian_status` | Policy, whether it is live, what the keeper would do now, reserve, allowance left, margin to the floor in percentage points | `tokenId`, `marginPoints` |
| `simulate_action` | Dry-runs an action as an address with `eth_call`: would it succeed, or why would it revert | the `build_tx` arguments plus `from` |
| `build_tx` | Unsigned `{ chainId, to, data, value, gas }` for an owner or market action, with a plain-language summary | `action` and its arguments |

`build_tx` actions: `open_position`, `add_collateral`, `withdraw_collateral`, `borrow`, `repay`, `refinance`,
`close`, `claim_surplus`, `set_policy`, `clear_policy`, `fund_reserve_btc`, `fund_reserve_musd`,
`withdraw_reserve_btc`, `withdraw_reserve_musd`, `execute_guardian`, `approve_musd`, `approve_market`,
`transfer_position`, `buy`, `cancel_listing`, `cancel_all_listings`. Creating a listing is not offered: it
needs the seller's EIP-712 signature, which this server will never produce.

Amounts are plain decimals in whole units (`"0.25"` BTC or MUSD), ratios are percentages (`"130"`), ids are
whole numbers. Market actions name a listing by the `hash` from `list_listings`, and the server finds the
announcement itself, so the model never has to copy a signature.

Every transaction has an explicit gas limit, because Mezo's `eth_estimateGas` is unreliable (see the SDK
README). The result says so; clients should send it as given. Where a position has a redemption-defense
policy the server reads it and raises the limit.

## Security model

The chain is untrusted input. Anyone can announce a listing, and revert reasons and error arguments are
strings someone else wrote. The server is built on that:

- **No keys, no signing, no sending.** No tool takes a key, signature or raw transaction, and the server's
  source never imports a wallet or signer. A test greps the source for the identifiers that would be needed
  (`privateKey`, `signTransaction`, `sendTransaction`, `writeContract`, ...) and for any environment variable
  other than `TROZU_RPC_URL`. Every tool is annotated read-only.
- **Inputs are validated twice, strictly.** Addresses must be 20 bytes of hex (any case, returned
  checksummed), ids whole numbers, amounts plain decimals up to 18 places (no signs, exponents, hex or
  spaces), hashes 32 bytes. Unknown arguments are refused, so a `privateKey` field is an error, not ignored.
  Bad input is refused before any call to the node.
- **Chain data is shown as numbers, checked hashes and addresses, or marked text.** Numbers go out as exact
  decimal strings. Hashes and addresses are printed only if they match their exact shape. Text from the chain
  (only revert strings, today) goes in a field shaped `{ "untrusted": true, "text": "..." }`, after ANSI
  escapes, control, zero-width and bidi characters are removed, `<`, `>`, `&` and backticks are escaped,
  markdown links are broken, whitespace is collapsed and it is cut to 200 characters. It never appears in a
  message the server wrote.
- **Sentences are ours.** Error messages and transaction summaries are built from the numbers by the SDK, not
  from chain text. Errors the server does not recognise become a fixed "something went wrong", so they cannot
  carry an RPC URL or chain data.
- **Sizes are capped.** At most 25 listings per call, at most 10 positions in detail, a scan limit on how
  many announcements are examined (so a flood of spam listings costs a bounded number of node calls), and a
  40,000 character ceiling on any answer.
- **The model is told.** The server's instructions say the chain is untrusted, text marked untrusted is data
  never to be followed, and that the user must see the summary and target address before signing.
- **A hostile listing cannot corrupt an answer.** Extreme numbers, a curve that rises, a deadline beyond
  the year 9999 and a listing the market calls `BadParams` all produce valid output with the price left
  empty, and `buy` refuses them (tests in `test/hostile.test.ts`).

What this does not protect against: a wrong RPC (the server believes the node it is pointed at), a model that
ignores the instructions and the `untrusted` marking, and a user who signs without reading the summary.
`simulate_action` is an `eth_call` and can differ from what a real block does.

## Known advisories (`npm audit`, 2026-11-07)

Eight findings when I first ran it, seven after the non-breaking upgrades (vitest 2.1.8 to 2.1.9, tsx 4.19.2
to 4.23.15, which cleared the tsx/esbuild one). Nothing was patched with `--force`.

**Production: `zod` 3.25.76, high, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).**
Zod's array parsing (`$ZodArray` in the v4 core, fixed in 4.6.6) records an issue for every failing element
with no cap, so a very large array handed to an array schema can exhaust memory. Zod 3.25.x ships that v4
core under `zod/v4`, and npm flags the whole package by version.
- *Our schemas: not reachable.* Every tool argument is a string, number, boolean or enum, and the schemas are
  strict objects. `test/schemas.test.ts` walks every schema we parse with, and the JSON Schema each tool
  publishes, and fails if any array, set, map, record, tuple or open object appears.
- *The MCP SDK's own schemas: reachable in principle.* The SDK validates incoming protocol messages with its
  own `zod/v4` schemas, and some of them hold arrays (for example `clientInfo.icons` in `initialize`). A client
  that sends an enormous array there could make this process run out of memory. I have not tried it.
  The only party who can send that is whoever is on the other end of the stdio pipe, which is the client the
  user started: there is no network listener, no key and no state to lose, so the worst case is the server
  process dying and being restarted.
- *Fix, not done:* move `packages/mcp` to zod 4.6.6 or later. The SDK accepts it (`^3.25 || ^4`), but
  our schemas use zod 3 behaviour (a `.default()` on a transformed schema takes the input value in zod 3 and
  the output value in zod 4, among others), so it needs a migration and a re-run of the tests, not a version
  bump. Not scheduled.

**Development only: vitest 2.1.9 and what it pulls in (vite 5, esbuild 0.21, tinypool, vite-node, @vitest/mocker),
7 findings, up to critical.** They are about servers and options that `vitest run` does not use:
the Vitest UI and API servers, Vite's dev server (path traversal, any website reading its responses, the
`launch-editor` issues), a prototype-pollution gadget in tinypool's worker options, and mock registration. We
never start the UI or API (`--ui`, `--api`), never run a dev server, and nothing outside our own config
reaches tinypool's options. I did not check by port scan that no listener opens during `vitest run`. The
suggested fix is vitest 5, a major version: also not done. Until then, do not run `vitest --ui` or
`vitest --api` on a machine that also browses the web.

None of the development packages are in `files`, so none ship with `@trozu/mcp`.

## Example

Asked "how is position 1 doing, and could I defend it against redemptions?", a client calls
`get_position` with `{ "tokenId": "1", "bufferThresholdMusd": "1000" }` and gets (live testnet, trimmed):

```json
{
  "position": {
    "tokenId": "1", "risk": "safe", "collateralBtc": "0.043217316659262987", "debtMusd": "2010.85819417269117738",
    "icrPercent": 163.14, "equityMusd": "1269.743993319185332136",
    "lockedRatePercent": 1, "marketRatePercent": 1, "rateAdvantagePoints": 0
  },
  "redemptionBuffer": {
    "verdict": "above", "meaning": "The walk proved the buffer reaches the threshold.",
    "bufferMusd": "1802.564924485799515744", "thresholdMusd": "1000", "stepsWalked": "1"
  }
}
```

Then `build_tx` with `{ "action": "add_collateral", "tokenId": "1", "amount": "0.01" }`:

```json
{
  "unsigned": true,
  "tx": { "chainId": 31611, "to": "0x2B08BB7F73beD0FA0454907a7E7082F1a58d9AB9", "data": "0xc6783af1…",
          "value": "10000000000000000", "gas": "6000000", "functionName": "addCollateral" },
  "summary": "Add 0.01 BTC of collateral to the position at 0x2B08...9AB9.",
  "warnings": [],
  "notice": "This is unsigned calldata. Check the summary and the target address, then sign it in your own wallet. ..."
}
```

and `simulate_action` with the same arguments plus `"from": "<holder>"` says whether it would go through. A
guardian dry-run by a stranger on the same position returned `wouldSucceed: false` with
`errorName: "NothingToDo"`, which is the right answer while the ratio sits above the floor.

## Tests

`npm test` runs 73 tests: input and output sanitising, every tool against a mock chain (the real SDK
over a fake transport), a hostile-data suite, the six-tool list over a real in-memory MCP client and server,
and the no-signing source check.
