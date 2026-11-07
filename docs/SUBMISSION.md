# Submission answers

Text for the AKINDO form. It uses only facts from this repository. Anything in square brackets is a placeholder or something to confirm. Character counts below were measured, not estimated.

## Project name

_4 characters_

```
Trozu
```

## Project category (3 to 5 words)

_28 characters_

```
Tradable MUSD debt positions
```

## TL;DR (one sentence)

_191 characters_

```
Trozu puts each MUSD trove inside a vault controlled by an NFT, so a position, with its collateral, debt and locked interest rate, can be handed over as one object; it is live on Mezo testnet.
```

## How it works (max 3000 characters)

_2532 characters_

```
On Mezo, a MUSD trove is keyed to the address that opened it and cannot be transferred. Its interest rate is fixed per trove when it opens, and only refinance() changes it, to whatever the global rate is at that moment, higher or lower. Redeemers burn MUSD for collateral starting with the lowest-ratio troves. So handing a position to a team wallet, a client or a buyer means repaying the debt, closing the trove and reopening at today's rate. The locked rate is lost and the opening fee is paid again.

Trozu removes that limit. PositionFactory opens each trove from its own vault contract (an EIP-1167 clone), so the vault is the trove's borrower, and then mints an ERC-721 for it. The vault checks nft.ownerOf(tokenId) on every holder call and stores no owner of its own. Sending the NFT moves the whole position at once: collateral, debt and locked rate. The previous holder, and anyone they approved, is locked out in the same transaction, and funds only ever go to the caller.

How MUSD is used. Trozu calls the real MUSD contracts: BorrowerOperations to open, adjust, repay, refinance and close, and TroveManager and SortedTroves to read state. Mezo's refinance can raise a trove's rate, so the vault wrapper only allows a strictly lower rate and caps the fee. Every read uses getEntireDebtAndColl, so accrued interest and pending redistribution are included, which the plain getters leave out. Opening passes sorted-list hints looked up right before sending; on testnet that measured about 0.6M gas against about 4.5M with no hints. A read-only lens reports collateral ratio, equity, locked versus market rate, and a redemption buffer: how much MUSD must be redeemed before the trove is reached in redemption order. The buffer is exact only when the walk completes, and the lens says which. Wallets connect through Mezo Passport.

Viability. Hypothesis, not yet tested: DAOs, treasuries, funds and OTC desks that borrow MUSD need to hand over or settle positions without unwinding them, and a below-market locked rate has value that cannot move with the position today. Next come a marketplace where the buyer commits to bounds, so a seller cannot empty a position between listing and sale, and a guardian with on-chain policy bounds. There is no user or revenue data yet.

Today: deployed on Mezo testnet, contracts verified on Sourcify, live app, and a position transferred to a second address and back on chain. 260 Foundry tests as `forge test` reports them (18 invariant functions, folded into the count), 299 web tests, 24 keeper tests and 213 package tests (SDK, MCP, alerts), with fork tests against the real MUSD contracts. Not audited.
```

## Target group

_620 characters_

```
User type: Bitcoin holders who borrow MUSD, and teams that hold a position together (DAOs, treasuries, funds, OTC desks). These are hypotheses; there is no user data yet.
Experience level: intermediate to advanced DeFi users who already understand troves, collateral ratios and liquidation.
Region: global. No regional focus, and no regional data.
Device: desktop first, because it is wallet based. The layout was checked at 390 and 360 px for mobile.
Alignment with the track: it builds directly on MUSD troves and Mezo's redemption and rate mechanics, and adds something a trove cannot do today, which is change hands.
```

## Tech stack

_262 characters_

```
Solidity 0.8.24 (london EVM), Foundry, OpenZeppelin 5.2, EIP-1167 clones, ERC-721.
Real MUSD contracts (pinned commit) for tests; Mezo Passport 0.17, wagmi 2, viem, RainbowKit.
Next.js 14, React 18, TypeScript, anime.js, Vitest.
GitHub Actions, Sourcify, Vercel.
```

## Track

_221 characters_

```
Track 1, and both tracks if the form allows it. The product is built on MUSD troves and Mezo's own mechanics (fixed per-trove rate, redemption order). [Confirm the track names on the form; they are not in the repository.]
```

## Chain deployed on

_29 characters_

```
Mezo testnet (chain id 31611)
```

## Project status

_345 characters_

```
Entirely new, built from an empty repository during the build period. The first commit is dated 16 Oct 2026 and the history has more than 130 commits through 22 Oct 2026, with no earlier code. The only third-party code is vendored as git submodules: the MUSD contracts, used by the tests, and OpenZeppelin. [Confirm the build period start date.]
```

## Project readiness

_147 characters_

```
Testnet deployment. Four contracts are deployed on Mezo testnet and verified on Sourcify, and the web app is live. Not audited, and not on mainnet.
```

## Future milestones

_678 characters_

```
1. Marketplace with state-committed settlement. Target: by 15 Nov 2026. The buyer commits to bounds on collateral, debt and locked rate, and the sale settles only if the position still meets them. Signed off-chain listings with on-chain cancellation, and a Dutch auction mode.
2. Guardian with on-chain policy bounds. Target: after the marketplace; no date committed. The owner sets limits (a ratio floor, capped top-ups, refinance only when the rate improves enough). Anyone can run an action, and it only succeeds inside those limits. Ships as a second vault version with a keeper script.
3. Independent audit. Before any mainnet use; no date. Mainnet deployment waits for it.
```

## Team info

_170 characters_

```
Name: [fill in]
Role: [fill in]
Background: [fill in]
X / LinkedIn: [fill in]
Contact: [fill in]
GitHub: https://github.com/Oladayo-Ahmod/keel
(Repeat for each teammate.)
```

## Links

- Repository: https://github.com/Oladayo-Ahmod/keel
- Live app: https://keel-two-roan.vercel.app/
- Deck: `docs/submission/trozu-deck.pptx` (11 slides, speaker notes with a timed 2 minute script on slides 2 to 8)
- Deployments, with transaction hashes: `docs/DEPLOYMENTS.md`
- Threat model: `docs/THREAT_MODEL.md`
- Sourcify: factory https://repo.sourcify.dev/31611/0xCDf7E1a6Be19EcE762477Cf89c786B9216307405, NFT https://repo.sourcify.dev/31611/0xEF892989eAa3acB203803aA8b4946a40815F948C, vault implementation https://repo.sourcify.dev/31611/0x7A546Ba684D8A7bdcA408F4f2e65e4E3F112208E, lens https://repo.sourcify.dev/31611/0x5e499cA8643cB4aB56a2E0A6E34De3DFb8DfFBD9
- Pitch video: [fill in]

## Video script (2 minutes)

It follows slides 2 to 8 of the deck. The same lines are in the speaker notes.

| Time | Slide | Say |
|---|---|---|
| 0:00 to 0:12 | 2 | A MUSD trove belongs to one address and can't move. To hand a position over, you repay, close, and reopen at today's rate, and you pay the opening fee again. |
| 0:12 to 0:24 | 3 | Each trove's interest rate is fixed when it opens, and the market rate can move later. The gap is real value, but it can't be moved or priced today. |
| 0:24 to 0:42 | 4 | Trozu opens each trove from a vault contract and puts the vault under an NFT. The vault asks the NFT who owns it on every call, so there is no stored owner to update. Send the NFT and the whole position moves. |
| 0:42 to 1:02 | 5 | Here it is live on Mezo testnet. I sent position two to a second address. The old holder's call reverts with NotHolder. The same call from the new holder succeeds. Both transactions are on the explorer, and the hashes are on screen. |
| 1:02 to 1:22 | 6 | This is the live app. The gauge shows the collateral ratio next to the locked and market rates, and the redemption buffer on demand. You open a position from a form, and transfer it through a review step that shows ratio and equity first. |
| 1:22 to 1:46 | 7 | It runs on the real MUSD contracts. The vault is the trove's borrower. Mezo's own refinance can raise your rate, so the wrapper only allows a lower one. Reads use getEntireDebtAndColl, so interest and redistribution are included. Hints are looked up right before sending. |
| 1:46 to 2:00 | 8 | 260 Foundry tests, 18 invariants and a state-machine fuzz run against the real MUSD contracts. Three broken vaults were each caught. It is testnet only and not audited. |

Do not say: that it is audited, that it is on mainnet, that a marketplace or guardian exists, or any user, volume or revenue number. None of those are true yet.
