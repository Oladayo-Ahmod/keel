# Integrating with Trozu

How another protocol reads a Trozu position. Everything here is on the Mezo testnet (matsnet); there is no
mainnet deployment. No protocol has integrated yet: this page shows how it would be done, not who did it.

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

A runnable version with example acceptance rules is in
[`packages/sdk/examples/assess-position.ts`](../packages/sdk/examples/assess-position.ts) (run on matsnet on
2026-11-07 against position 1, it returned `accept: true` at a ratio of 162.99%). The thresholds in it are
the example's own; pick yours.

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
[MCP README](../packages/mcp/README.md) for the tool list and the security model.

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
