# @trozu/sdk

Read Trozu positions, listings and guardians from Mezo, and build unsigned transactions for them.
Built on viem. It never signs, never sends and never holds a key: every write is a `{ chainId, to, data,
value, gas }` object for your own wallet to sign.

Addresses and ABIs are for the Mezo testnet (matsnet) deployment of 2026-11-06 and are copied from the
repository root into `src/generated` by `npm run sync` (a test fails if they drift).

```ts
import { createTrozu } from "@trozu/sdk";

const trozu = createTrozu(); // matsnet over the public RPC; pass { client, deployment } to change either

const p = await trozu.lens.position(1n);
p.icr;            // 1e18 ratio, 1.6e18 is 160%
p.equity;         // collateral value minus debt, MUSD wei, negative if under water
p.lockedRateBps;  // the rate the position locked in
p.marketRateBps;  // the rate a new borrower pays today
p.risk;           // "safe" | "caution" | "danger" | "liquidatable" | "none"

const b = await trozu.lens.bufferCheck(1n, 50_000n * 10n ** 18n); // redemption buffer against a threshold
b.verdict;        // "above" | "below" | "unknown": unknown means the walk ran out of steps, not that it is safe

const g = await trozu.guardian.status(1n);
g.policy; g.live; g.plan; g.reserve; g.allowance; g.marginToFloor;

const open = await trozu.market.listings({ onlyOpen: true, limit: 10 });
const q = await trozu.market.quote(open[0].listing, open[0].signature); // price now, fee, recommended buyer bounds

const tx = trozu.tx.addCollateral({ vault: p.vault, amount: 10n ** 16n });
await trozu.simulate(tx, holderAddress); // eth_call as the holder, returns { ok } or a typed error
// hand tx.to, tx.data, tx.value and tx.gas to a wallet. Do not let it re-estimate the gas.
```

## What is in it

| | |
|---|---|
| `lens` | `position`, `positionsOf`, `redemptionBuffer`, `bufferCheck` |
| `market` | `listings` (announcements, newest first, each run through the market's own `check`), `quote`, `check` |
| `guardian` | `status`: policy, live flag, the plan `execute` would follow, reserve, allowance left, margin to the floor |
| `tx` | open, add/withdraw collateral, borrow, repay, refinance, close, claim surplus, sweep, set/clear policy, fund/withdraw reserve, execute, MUSD approve, market approve, transfer, announce, cancel, cancelAll, buy |
| `simulate` | eth_call a built transaction as an address |
| `hints` | sorted-list hints from Mezo to cut gas |

Amounts are wei bigints (BTC and MUSD both have 18 decimals). Builders also accept decimal strings, because
JSON cannot carry a bigint.

## Gas

Every builder sets `gas`. Mezo's public node answered `eth_estimateGas` with about 21,300 for a call that
needed about 5.6M, so the limit is the larger of the measured gas plus 30% and a floor (1M for calls that
leave Mezo's sorted list alone, 6M for calls that re-sort the trove), capped at 9.5M. The numbers come from
the live proof run (`docs/PROOF.md`). Mezo charges at least half the limit, so 6M costs about 3M gas.
Pass `gas: { defenseWalk: true }` for a position with a redemption-defense policy: its walk needs more than
the 6M floor. Most actions have no measurement of their own yet; for those only the floor applies.

## Errors

Everything the SDK throws on purpose extends `TrozuError` with a `code`: `VALIDATION`, `NOT_FOUND`, `RPC`,
`REVERT` or `UNKNOWN`. `decodeRevert(e)` turns any viem error into one. Reverts become `TrozuRevertError`
with `errorName`, decoded `args` and a sentence in `message`; `ListingInvalidError` carries the market state,
`BoundsError` says which buyer bound failed and `BadPolicyError` carries the contract's reason string.
Text that came from the chain is only ever in `chainText`, never in `message`.

## Tests

`npm test` runs the mock-chain tests (a viem client over a fake transport that decodes and encodes real
calldata). `npm run test:matsnet` runs read-only checks against the live testnet RPC.
