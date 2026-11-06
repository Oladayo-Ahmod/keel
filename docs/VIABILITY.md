# Viability

Everything in this document is either read from chain (and reproducible with `script/market_data.py`), taken from the code in this repository, or labelled as a hypothesis. There are no forecasts.

## What the chain says

All figures are Mezo mainnet at block 13,040,764 (2026-11-06). The full tables, limits and the script are in [MARKET_DATA.md](MARKET_DATA.md).

**Redemption is the dominant event in this market.** 1,204 redemption transactions have redeemed 5,896,607.88 MUSD. 712 of them, 1,291,133 MUSD, happened in the last million blocks (since 2026-09-23). The largest single redemption was 284,083.87 MUSD, the median 984.21 MUSD. Redemption takes troves from the lowest collateral ratio first, so a position near the bottom of the sorted list is the one that gets redeemed against, whether or not its owner wants that.

**The book is small.** Today there are 3 active troves holding 71,696.20 MUSD of debt against 17.4676 BTC. 641 troves have been opened since launch and 28 liquidated (827,968 MUSD of debt, 12.33 BTC). The market is large in flow and small in stock: most of what was borrowed has already been redeemed or repaid.

**The interest rate has never moved.** The global rate is 1.00% and has been since launch. All 641 opens and all 215 refinances locked 100 bps. There have been no rate proposals. Trozu does not claim a rate premium, because there is none in the data to price. A position's locked rate matters only if governance changes the global rate; nothing here says that will happen.

**Revenue today is zero.** The marketplace contract that would earn a fee has not processed a sale on mainnet. It is deployed on testnet only. Nothing in this document is income.

## The problem

Two facts about a Mezo trove, both verified against Mezo's contracts (see [VERIFICATION.md](VERIFICATION.md)):

1. A trove belongs to one address and cannot be handed to another. To move a position to someone else the owner has to close it, losing the locked rate and paying the exit, and the other party has to open a new one.
2. Redemptions hit the lowest ratio first, and the borrower has no standing defense. The only response is for the owner to notice and top up by hand.

Trozu puts the trove inside a vault represented by an ERC-721, which fixes the first (the position, with collateral, debt and locked rate, is one transferable object), and adds a bounded guardian for the second.

## Users

These are hypotheses. I have not interviewed anyone and I have no usage numbers, no users and no partners to cite.

- **A borrower who wants out of a position without unwinding it** (hypothesis). Sells the position as one object to a buyer who takes over the debt and the collateral. The marketplace exists for this. Whether anyone wants to buy debt positions is untested.
- **A borrower near the bottom of the list who cannot watch the chain all day** (hypothesis, but the redemption volume above is evidence that the event is common). Funds a reserve and sets a floor and a redemption-buffer threshold; anyone can then trigger the top-up inside the policy. The guardian is meant for this person.
- **A keeper** (hypothesis). Anyone can call `execute()` and earns a tip capped in code at 0.0001 BTC. Whether the tip covers gas on mainnet has not been measured.

## Revenue model

One source, and it is not earning anything yet.

- **Marketplace fee.** A fixed percentage of the sale price, taken from the price the buyer pays. Default 25 bps (0.25%). The contract refuses to deploy with more than 100 bps, and the fee and its recipient are immutable: there is no owner and no setter, so the rate can neither be raised later nor redirected. As an arithmetic example, not a projection: a 2,000 MUSD sale carries a fee of 5 MUSD.
- **Nothing else.** The keeper tip goes to the keeper, not to Trozu. There is no token, no subscription and no fee on opening, closing or the guardian. The Wave 1 contracts charge nothing.

On the testnet deployment the fee recipient is the deployer address, because no other address was specified. It cannot be changed after deployment.

## Honest competition and alternatives

- **Mezo's own tools.** Mezo's own app is where troves are opened, adjusted and closed today, and Mezo also offers the MUSD savings vault. I have not audited every feature of that app, so treat any claim here that it lacks a feature as unchecked. A borrower can already top up by hand. Trozu does not replace that interface; it adds transfer, sale and a standing defense on top of the same contracts. If Mezo adds transferable positions or its own auto-protection, the overlap is direct.
- **Doing it by hand or with a generic bot.** A holder can watch their ratio and top up manually, or run their own script. The guardian's value is that anyone can trigger it inside bounds the holder set, with an explicit reserve and a cap on what a keeper can take, so the holder does not have to run infrastructure. It is not a new capability, and a competent operator may not need it.
- **Closing and reopening.** For a seller it is the status quo. It costs the locked rate (irrelevant while the rate is flat) and fees.
- **Other projects.** I have not reviewed other submissions and make no comparison.

## Why Mezo, why now

- The redemption flow above is real and recent, and the book is thin enough that any one borrower is close to the redemption front.
- MUSD is a Liquity-style system with a sorted list, so a redemption buffer can be computed on chain by a bounded walk. The Wave 1 lens already does this and the guardian reuses it.
- A trove's locked rate only differentiates positions if the global rate changes. It has not, so today the value of a position is its collateral, its debt and its place in the list, and a sale price should reflect that.

## What would change this assessment

- A rate proposal from governance would make locked rates, and therefore position pricing, meaningful. Until then the marketplace has to justify itself on handing over a position without closing it.
- A mainnet book that stays at three troves is a small market for any product built on positions. The data cannot say whether the stock grows.

## Status and limits

- Testnet only. Not audited. The review in [REVIEW.md](REVIEW.md) is AI-assisted, not an independent audit.
- The guardian cannot rescue a position already under 110% unless one action, inside the policy caps, lifts it back over; Mezo reverts anything else in normal mode.
- Reading the order book means scanning logs in 10,000-block windows on Mezo's public RPC.
