# Submission answers

Text for the AKINDO form. It uses only facts from this repository. Anything in square brackets is a placeholder or something to confirm. Character counts below were measured by the script that wrote this file, not estimated. The links in this file are read by `script/check_links.py` with the rest of `docs/submission/`; the video link is a placeholder and is flagged until the real one is pasted.

The form's long answer is "How it works". It opens with what Trozu is and what the chain says, then maps what changed since Wave 1 to each of the four things the judges asked for. The deck is `docs/submission/trozu-deck.pptx` and, hosted with the app, `web/public/trozu-deck.pdf`. The video script is [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md).

## Project name

_21 characters_

```
Trozu (formerly KEEL)
```

## Project category (3 to 5 words)

_28 characters_

```
Tradable MUSD debt positions
```

## TL;DR (one sentence)

_202 characters_

```
Trozu (formerly KEEL) puts each MUSD trove in a vault controlled by an NFT, so a position can be sold or handed over as one object, or protected by a bounded guardian. Live on Mezo testnet, not audited.
```

## How it works (max 3000 characters)

_1895 characters, limit 3,000: 1105 to spare_

```
On Mezo, a MUSD trove belongs to one address and cannot be moved, and redemptions take collateral from the lowest-ratio troves first. Trozu opens each trove from a vault controlled by an NFT, so collateral, debt and locked rate move as one object. A marketplace and a guardian sit on top. Testnet only, not audited. On mainnet today there are 3 troves and the global rate has been 1% since block 0, so Trozu earns nothing.

What changed since Wave 1, by judge comment:

1. Marketplace with bounded settlement. TrozuMarket sells a position at a fixed or falling price from a signed listing. The buyer sets bounds on collateral, debt, rate, reserve and price. One transaction checks them, pays the seller and the fee, and moves the NFT. On testnet: a 100 MUSD sale with a permit, a Dutch sale at 115.67 MUSD, and refusals (StaleEpoch, CollateralBelowMin, ReserveBelowMin).

2. Guardian. The holder funds a reserve and sets a floor, caps and a keeper tip of at most 0.0001 BTC. Anyone can call execute; it acts only if the vault's planner agrees, and it never refinances. A keeper lifted a position from 135.07% to 145.17%. A redemption defense acted only after a complete queue walk. The testnet oracle cannot move, so the floor was set above the ratio.

3. Actions in the app. Add and withdraw collateral, borrow, repay with a permit, sweep, reserve, policy, list, buy, cancel and transfer ran through the app's own screens, with transactions listed. Open, close, claim surplus and refinance did not run through the UI.

4. Revenue model. 25 bps of the sale price, capped at 100 bps in code, paid by the seller to one recipient fixed at deployment. Revenue today is zero; the testnet fees came from the team's own sales.

Also published: a proof page, a break-it page with the attacks that worked, 260 Foundry tests, an AI-assisted review (not an audit), an SDK, an MCP server and webhook alerts.
```

## Target group

_622 characters_

```
User type: holders of a trove near the front of the redemption queue who cannot watch the chain, then people moving a position between wallets, then keepers. These are hypotheses: there is no user data, and the only users so far are the team's own wallets.
Experience level: intermediate to advanced DeFi users who understand troves, collateral ratios and liquidation.
Region: global. No regional focus, and no regional data.
Device: desktop first, because it is wallet based. The layout was checked at 390 and 360 px for mobile.
Alignment with the track: it builds on MUSD troves and Mezo's redemption and rate mechanics.
```

## Tech stack

_345 characters_

```
Solidity 0.8.24 (london EVM), Foundry, OpenZeppelin, EIP-1167 clones, ERC-721, EIP-712 signed listings.
Real MUSD contracts (pinned commit) for tests; Mezo Passport 0.17, wagmi 2, viem, RainbowKit.
Next.js 14, React 18, TypeScript, anime.js, Vitest.
Keeper script, TypeScript SDK, MCP server and alerts package.
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

_495 characters_

```
Entirely new, built from an empty repository during the build period. The first commit is dated 16 Oct 2026. 186 of the 320 commits in the history were written between 2 and 8 Nov 2026 (counted by author date, through commit 6db65aa): the marketplace, the guardian, the keeper, the app features, the SDK, the MCP server and the alerts script. The only third-party code is vendored as git submodules: the MUSD contracts, used by the tests, and OpenZeppelin. [Confirm the build period start date.]
```

## Project readiness

_306 characters_

```
Testnet deployment. Nine contracts are deployed on Mezo testnet: four original and five Trozu contracts (factory, NFT, lens, vault implementation, market). All nine are exact Sourcify matches (checked 2026-11-08). The app is live and a keeper workflow is in the repository. Not audited, and not on mainnet.
```

## Future milestones (a post-hackathon plan, each answer under 1,000 characters)

### 1. Independent audit

_424 characters, limit 1,000: 576 to spare_

```
Today the contracts are testnet only and not audited. The review in docs/REVIEW.md is AI-assisted, and docs/VIABILITY.md says in so many words that it is not an independent audit. Nothing in VIABILITY.md schedules an audit: no auditor, date or budget is chosen. This milestone is to get one independent review of the contracts, and to publish what it finds the way the AI-assisted one was published, including what it broke.
```

### 2. Capped mainnet

_428 characters, limit 1,000: 572 to spare_

```
VIABILITY.md has no mainnet plan, and this is not one. What it does say: nothing is deployed on Mezo mainnet; the mainnet book is 3 troves (71,696 MUSD of debt), so it is a small market for any product built on positions; and whether a keeper's tip covers gas on mainnet has not been measured. Any capped mainnet release would have to start from those three facts. The size of a cap and a date are not decided in the repository.
```

### 3. First real users

_503 characters, limit 1,000: 497 to spare_

```
Everything on testnet so far was run by the team. VIABILITY.md names who to look for, in order: a holder of a trove near the front of the redemption queue who cannot watch the chain; someone moving a position between wallets; a keeper; and a buyer, last. It asks four questions so replies can be compared (do you watch your ratio, have you been redeemed against, would you fund a reserve, would you buy a position) and has a table for real replies, in their words. The milestone is the first filled row.
```

### 4. Integrations

_532 characters, limit 1,000: 468 to spare_

```
VIABILITY.md plans no integrations. What exists is in docs/INTEGRATIONS.md: a TypeScript SDK that builds unsigned transactions, a read-only MCP server for Claude Desktop and Claude Code (handshake tested, not yet run in a real client), and webhook alerts. VIABILITY.md does name two things that bear on this: keepers, who earn a capped tip, and the risk that Mezo adds transferable positions or its own auto-protection, which would make the overlap direct. This milestone is to see whether anyone outside the team builds on the SDK.
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
- Proof page: https://keel-two-roan.vercel.app/proof
- Break-it page: https://keel-two-roan.vercel.app/break-it
- Live stats: https://keel-two-roan.vercel.app/stats
- Deck (PDF, 13 slides): https://keel-two-roan.vercel.app/trozu-deck.pdf (source and pptx: `docs/submission/trozu-deck.pptx`)
- Pitch video: https://www.youtube.com/watch?v=VIDEO_ID_TO_FILL (placeholder: `script/check_links.py` flags it until the real link is pasted)
- Viability and revenue model: https://github.com/Oladayo-Ahmod/keel/blob/main/docs/VIABILITY.md
- Review (AI-assisted, not an audit): https://github.com/Oladayo-Ahmod/keel/blob/main/docs/REVIEW.md
- Live proof run, transaction by transaction: https://github.com/Oladayo-Ahmod/keel/blob/main/docs/PROOF.md
- Wallet round trip through the app: https://github.com/Oladayo-Ahmod/keel/blob/main/docs/ROUNDTRIP.md
- Integrations (SDK, MCP, alerts): https://github.com/Oladayo-Ahmod/keel/blob/main/docs/INTEGRATIONS.md
- Deployments, with transaction hashes: https://github.com/Oladayo-Ahmod/keel/blob/main/docs/DEPLOYMENTS.md
- Threat model: https://github.com/Oladayo-Ahmod/keel/blob/main/docs/THREAT_MODEL.md
- Sourcify, Trozu contracts: factory https://repo.sourcify.dev/31611/0x70791379537cB14981AA7114678663164141eC31, NFT https://repo.sourcify.dev/31611/0xd53f649e4df31351De8935De9cA7110888F055b8, lens https://repo.sourcify.dev/31611/0xCCF8c5aFe7473eC41F64906071e1bE497872004C, vault implementation https://repo.sourcify.dev/31611/0x6ef4395325828083672FFe836d6Bc80Bf22cACFE, market https://repo.sourcify.dev/31611/0xEae6fEa26B178eF32829F36e5219363bB30D93DB
- Sourcify, original contracts: factory https://repo.sourcify.dev/31611/0xCDf7E1a6Be19EcE762477Cf89c786B9216307405, NFT https://repo.sourcify.dev/31611/0xEF892989eAa3acB203803aA8b4946a40815F948C, vault implementation https://repo.sourcify.dev/31611/0x7A546Ba684D8A7bdcA408F4f2e65e4E3F112208E, lens https://repo.sourcify.dev/31611/0x5e499cA8643cB4aB56a2E0A6E34De3DFb8DfFBD9
