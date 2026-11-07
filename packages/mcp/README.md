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

Claude Desktop, or any client that takes a command:

```json
{
  "mcpServers": {
    "trozu": { "command": "node", "args": ["/path/to/keel/packages/mcp/dist/cli.js"] }
  }
}
```

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
