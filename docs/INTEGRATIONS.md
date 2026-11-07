# Integrating with Trozu

How another protocol reads a Trozu position. Everything here is on the Mezo testnet (matsnet); there is no
mainnet deployment. No protocol has integrated yet: this page shows how it would be done, not who did it.

**Every example and every recorded result below uses the v2 NFT with id 1 on matsnet** (vault
`0x2B08BB7F73beD0FA0454907a7E7082F1a58d9AB9`, held by the deployer wallet). It is the staged demo position, with
a live guardian policy and two live listings. Nothing here has been tried on any other position.

A Trozu position is an NFT (`TrozuNFT`). The NFT's holder owns a vault (`TrozuVault`) that owns a Mezo trove.
Selling or sending the NFT moves the whole position. So an integration is three questions: who holds it, how
healthy is it, and is anything protecting it.

## From TypeScript: `@trozu/sdk`

```ts
import { createTrozu, icrPercent } from "@trozu/sdk";

const trozu = createTrozu(); // matsnet over the public RPC; createTrozu({ client }) to bring your own viem client

const p = await trozu.lens.position(1n);
p.holder;        // who owns the NFT right now
p.active;        // false once the trove is closed
p.collateral;    // BTC, 1e18
p.debt;          // MUSD, 1e18, principal plus interest
p.icr;           // 1e18 ratio, 1.63e18 is 163%. At or above 2^200 there is no debt (p.hasDebt is false)
p.equity;        // collateral value minus debt, MUSD wei, negative if under water
p.risk;          // "safe" | "caution" | "danger" | "liquidatable" | "none"
p.lockedRateBps; p.marketRateBps; // the rate it locked in against today's rate for a new loan
p.priceOk;       // false if Mezo's price feed did not answer: do not trust icr or risk then

// can redemptions reach it? "unknown" means the walk ran out of steps. It is not "safe".
const b = await trozu.lens.bufferCheck(1n, 50_000n * 10n ** 18n, 100);
b.verdict;       // "above" | "below" | "unknown"

// is a guardian protecting it, and how close is it to acting?
const g = await trozu.guardian.status(1n);
g.live; g.policy.floorIcr; g.reserve; g.marginToFloor;
```

### The assess flow

[`packages/sdk/examples/assess-position.ts`](../packages/sdk/examples/assess-position.ts) turns those reads into
one decision for position `tokenId`, which the integrator believes is held by `expectedHolder`. It is the
SDK's flow for "may this position count for something?" (a lender's collateral check, a gated feature):

```ts
async function assess(tokenId: bigint, expectedHolder: string, bufferMusd: bigint) {
  const p = await trozu.lens.position(tokenId);            // 1. read it; throws TrozuNotFoundError for an unminted id
  const reasons: string[] = [];

  if (p.holder.toLowerCase() !== expectedHolder.toLowerCase()) reasons.push("held by someone else");   // 2. the holder
  if (!p.active) reasons.push("no open trove");
  if (!p.priceOk) reasons.push("price feed not answering");                                              // 3. can the ratio be trusted
  if (p.recoveryMode) reasons.push("Mezo is in Recovery Mode");
  if (p.risk !== "safe") reasons.push(`risk is ${p.risk}`);                                             // 4. is it healthy

  const buffer = await trozu.lens.bufferCheck(tokenId, bufferMusd, 100);                                 // 5. can redemptions reach it
  if (buffer.verdict !== "above") reasons.push(`redemption buffer is ${buffer.verdict}`);                // "unknown" is a fail

  const g = await trozu.guardian.status(tokenId);                                                        // 6. is it protected (optional)
  if (!g.live) reasons.push("no live guardian policy (optional)");

  return { accept: reasons.filter((r) => !r.endsWith("(optional)")).length === 0, reasons, position: p };
}
```

The thresholds in the file are the example's own (risk must be `safe`, a 1,000 MUSD buffer); pick yours. Run on
matsnet on 2026-11-07 against position 1 (`npx tsx examples/assess-position.ts 1`, run from `packages/sdk`), it
returned `accept: true` at a ratio of 162.99%.

Things to check before a position counts for anything:

1. **The holder.** Compare `p.holder` to the address you expect, at the moment you rely on it. The position
   moves with its NFT, and the NFT can be sold in the same block.
2. **`active` and `priceOk`.** `active` is false when the position has no open trove; a dead price feed
   (`priceOk` false) makes the ratio meaningless.
3. **A verdict of `unknown` is not a pass.** `bufferCheck` walks at most 100 troves.
4. **Ownership changes.** `TrozuNFT.transferEpoch(tokenId)` goes up on every transfer (and on mint). A
   guardian policy set by a previous holder is switched off automatically (`status.live` is false and the
   plan reason is `PolicyStale`), and a market listing signed before the transfer is refused as `StaleEpoch`.
   If you cache anything about a position, key it by `(tokenId, epoch)`.
5. **Reads are not locks.** Nothing here stops the holder changing the position after you read it. Use the
   numbers as a decision input, and re-read in the same transaction if you are on chain.

Errors are typed (`TrozuNotFoundError` for an id that was never minted, `TrozuRpcError` for a node failure,
`TrozuRevertError` for a contract refusal), see the [SDK README](../packages/sdk/README.md).

## Writing: unsigned transactions

`trozu.tx.*` builds `{ chainId, to, data, value, gas }` for a wallet to sign. Every builder sets a gas limit,
because Mezo's `eth_estimateGas` is unreliable (docs/PROOF.md): send the limit as given.

**Where each limit comes from.** The SDK's table is a copy of `web/src/lib/gas.ts`, and
`packages/sdk/test/webgas.test.ts` fails if any action differs from it or is missing. Each limit is labelled in
`packages/sdk/src/gas.ts`:

- *measured*: a receipt `gasUsed` in `docs/proof.json`, plus 30% (never under the floor): `openPosition`,
  `fundReserveBtc`, `setPolicy`, `execute`, `announce`, `cancel`, `buy`, `approve`, `safeTransferFrom`,
  `transferFrom`, `transfer`.
- *roundtrip*: no usable measurement, but that limit was sent through the app on matsnet in the wallet round
  trip (`docs/roundtrip.json`) and succeeded: `addCollateral`, `withdrawCollateral`, `borrow`,
  `repayWithPermit`, `sweep`, `fundReserveMusdWithPermit`, `withdrawReserveBtc`, `withdrawReserveMusd`.
  Every `gasUsed` in that file is exactly half its limit (Mezo charges at least half), so it shows the limit is
  enough, not what the call uses.
- **Unmeasured** (never sent on chain; only the floor applies, 6M for calls that re-sort the trove and 1M for
  the rest): `repay`, `refinance`, `close`, `closeWithPermit`, `claimSurplus`, `fundReserveMusd`,
  `clearPolicy`, `cancelAll`, `setApprovalForAll`. For these, a guess.

A position with a redemption-defense policy needs more than the floor (a defense `execute` needs about 7.3M),
so pass `gas: { defenseWalk: true }`, which uses the 9.5M cap. The MCP server does that itself.

### Simulated on matsnet with `eth_call` (nothing was sent)

`trozu.simulate(tx, from)` runs a built transaction as an address with `eth_call` at the builder's gas limit.
These are the results of the SDK's `test:matsnet` suite (off by default: `npm run test:matsnet -w @trozu/sdk`),
run 2026-11-07, 39 of 39 passing. Addresses: deployer (holder and seller) `0x5104C1A6…8F98`, second wallet
`0xf8B5CF02…EdEe2`, a stranger `0x…00a1`.

| Builder | As | Result |
|---|---|---|
| `buy`, the staged fixed 6,000 MUSD listing | second wallet | reverts `ERC20InsufficientAllowance` (needs 5,985 MUSD approved, has 0; it also holds only 84 MUSD) |
| `buy`, same, with MUSD balance and allowance given by a state override | second wallet | succeeds |
| `buy` with a bound that does not hold (max price 1 wei, wrong epoch, min collateral doubled, max debt 1 wei, min reserve doubled) | second wallet | reverts `PriceAboveMax`, `EpochMismatch`, `CollateralBelowMin`, `DebtAboveMax`, `ReserveBelowMin`, each typed |
| `cancel` | deployer (seller) / second wallet | succeeds / reverts `NotSeller` |
| `addCollateral` 0.0005 BTC | deployer (holder) / second wallet | succeeds / reverts `NotHolder` |
| `execute` (guardian) | stranger | reverts `NothingToDo`: the position is above its floor, so there is nothing to do. This is the expected answer, not a failure |
| `withdrawCollateral`, `borrow`, `fundReserveBtc`, `withdrawReserveBtc`, `clearPolicy`, `setPolicy` (as it is now), `sweep`, `approveMarketFor`, `approveMusd`, `transferPosition`, `cancelAll`, `announce` | deployer | succeed |
| `repay`, `close`, `fundReserveMusd` | deployer | revert `ERC20InsufficientAllowance` with no allowance; succeed with MUSD and an allowance given by a state override |
| `refinance` | deployer | reverts `NoRateImprovement` (market rate 1.00%, locked 1.00%) |
| `claimSurplus` | deployer | reverts with Mezo's own `CollSurplusPool: No collateral available to claim`, since there is none |
| `withdrawReserveMusd` | deployer | reverts `ReserveTooSmall`, the reserve holds no MUSD |
| `openPosition` below the minimum debt | deployer | reverts with Mezo's `net debt must be greater than minimum` |

**No builder's calldata reverted for an unexpected reason.** Every revert above is the right answer for the
state. One thing the first pass found was in the SDK, not the calldata: `buy`, `repay`, `close` and
`fundReserveMusd` came back as an unrecognised failure, because MUSD's own `ERC20InsufficientAllowance` bubbles
up through the market and vault and the SDK did not know that error (and showed Mezo's plain revert strings as
a bare "Error"). Fixed; they decode now.

How to read the "with a state override" rows: `eth_call` lets a caller pretend some storage holds other values
for that one call, and Mezo's public node accepts it. The test gives the wallet MUSD and an allowance by
writing MUSD's balance (storage slot 0) and allowance (slot 1) mappings, after checking those slots with
`balanceOf` and `allowance`. A success there shows the calldata and the contract logic accept the call. It does
not show the real wallet could send it, and nothing was signed or sent in any row.

## From a contract: the Lens

`PositionLens.positionInfo(tokenId)` returns the same struct the SDK maps (ratio, equity, rates, flags), and
`bufferAtLeast(tokenId, threshold, maxSteps)` returns the redemption verdict (0 unknown, 1 above, 2 below). Both
are `view`. Addresses are in `web/src/config/deployment.v2.json` and `docs/DEPLOYMENTS.md`; the ABI is
`abi/v2/PositionLens.json`. A Solidity integrator should treat `verdict == Unknown` and `priceOk == false` as
failures, for the reasons above. I have not written or tested a Solidity consumer of the Lens; the SDK path is
the one that has been run.

## From an AI agent: `@trozu/mcp`

The same reads, plus unsigned transactions, as MCP tools: `get_position`, `list_listings`, `quote_listing`,
`guardian_status`, `simulate_action`, `build_tx`. It cannot sign. See the
[MCP README](../packages/mcp/README.md) for the tool list, the security model, client config for Claude Desktop
and Claude Code, and the known npm advisories.

## Watching positions: `@trozu/alerts`

A script that posts to a webhook when a guarded position nears its floor or the keeper acts. See the
[alerts README](../packages/alerts/README.md).

## Limits to know about

- Testnet only. Addresses and ABIs are those of the 2026-11-06 deployment and can change with a redeploy; the
  SDK copies them into `src/generated` and has a test that fails if they drift from the repository.
- Mezo's public RPC caps `eth_getLogs` at 10,000 blocks and drops connections now and then. The SDK reads logs
  in 9,000 block windows; bring your own client and retry policy for anything you depend on.
- Transactions built by the SDK carry an explicit gas limit because the node's `eth_estimateGas` is unreliable
  on Mezo (docs/PROOF.md). Send the limit as given.

## What is unverified

- **Nothing here has been sent on chain by the SDK or the MCP server.** Every write path is checked by
  decoding the calldata back and by the `eth_call` simulations above. The only real transactions on matsnet
  are the ones from the proof run and the wallet round trip, which used the web app and the keeper, not the SDK.
- **A simulation is a hint.** State moves between a call and a block; the node can answer a call the chain then
  refuses. The `buy`, `repay`, `close` and `fundReserveMusd` successes depend on the state override.
- **Nine gas limits are guesses** (listed above). A defense-policy `execute` at the cap has not been run through
  the SDK either; the keeper's earlier success is the evidence.
- **Hints are not exercised on a real send.** `computeHints` was read-tested on matsnet. `build_tx` leaves hints
  out, which costs gas but never reverts.
- **The Lens from a contract** (above) and **any third-party integration**: untried.
- **The simulation results are for position 1 as staged on 2026-11-07.** If the staging changes (the listing is
  cancelled, the ratio falls under the floor so the guardian acts), some of the suite's expectations will
  change with it.
- **The alerts webhook** has not been posted to a real Slack or Discord endpoint, and the GitHub Actions job has
  never run on GitHub (see the alerts README). The MCP client snippets were checked with the SDK's own stdio
  client, not with Claude Desktop or Claude Code.
- **npm audit:** seven findings remain, one in production (zod, reasoned in the MCP README and in
  `docs/KNOWN_LIMITATIONS.md`) and six in development tooling.
