# Viability

Everything in this document is either read from chain (and reproducible with `script/market_data.py`), taken from the code or the live testnet runs in this repository, or labelled as a hypothesis. There are no forecasts, no user numbers and no partner names.

## The plain version

Trozu makes a Mezo trove into two things the trove is not today: an asset you can hand to someone, and a position that defends itself against redemption within limits you set.

- **Redemption defense.** Redemption takes collateral from the lowest-ratio troves first, and a borrower has no standing answer to it. A holder funds a reserve and sets a floor and a redemption-buffer threshold, and anyone can then trigger a top-up inside those bounds. This is the part of the product the mainnet data supports most directly.
- **The rate-locked position asset.** A position, meaning its collateral, debt and locked interest rate, is one ERC-721. It can be transferred, or sold on the marketplace with the buyer's bounds on collateral, debt, rate and reserve checked at settlement.

Three facts, stated first because they limit everything below:

1. **The mainnet book is 3 troves**: 71,696.20 MUSD of debt against 17.4676 BTC, at block 13,040,764.
2. **The global interest rate has been 1.00% since block 0.** No rate has ever been proposed. Every one of the 641 opens and 215 refinances locked 100 bps, so a locked rate has no price today.
3. **Trozu's revenue today is zero.** The marketplace contract that would earn a fee has not processed a sale on mainnet. It is deployed on testnet only.

## What the chain says

All figures are Mezo mainnet at block 13,040,764 (2026-11-06). The tables, limits and the script are in [MARKET_DATA.md](MARKET_DATA.md).

- **Redemption is the dominant event.** 1,204 redemption transactions have redeemed 5,896,607.88 MUSD. 712 of them, 1,291,133 MUSD, happened in the last million blocks (since 2026-09-23). The largest was 284,083.87 MUSD and the median 984.21 MUSD. A position near the bottom of the sorted list is the one redeemed against, whether or not its owner wants that.
- **The market is large in flow and small in stock.** 641 troves have been opened since launch and 28 liquidated (827,968 MUSD of debt, 12.33 BTC). Most of what was borrowed has already been redeemed or repaid.
- **The rate has never moved.** `InterestRateManager` has emitted no `InterestRateProposed` or `InterestRateUpdated` event, and `interestRate()` reads 100 at seven blocks spread over the chain's life. A change needs a proposal and a 7-day delay, and none has been proposed.

## Redemption defense

What exists and what was shown (all on testnet, all in [PROOF.md](PROOF.md)):

- The holder sets a policy: a ratio floor, a target, caps per action and per period, a keeper tip (at most 0.0001 BTC, enforced in code), and optionally a redemption-buffer threshold. A reserve of BTC or MUSD is held in the vault. Anyone can call `execute()`, and it acts only if the vault's own planner says the policy calls for it.
- A keeper topped a position up when its ratio fell under the floor, and a second action defended it when a complete queue walk proved the redemption buffer was under the holder's threshold. A keeper call made while the position was inside its policy, or on a policy left by a previous holder, was refused.
- It never refinances for the holder. Mainnet's rate has never moved, so there is nothing to refinance toward.

Limits that matter (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and DECISIONS 44):

- The buffer is known only from a complete walk of at most 100 troves. A position further back than that gets an "unknown" verdict, which never acts, by design.
- Mezo refuses any top-up that leaves a trove under 110% in normal mode, so a position already too low cannot be saved by one capped action.
- On testnet the oracle could not be moved, so the proof run sets the policy floor above the position's current ratio. It shows the mechanism works. It does not show how often a real holder would need it.

## The rate-locked position asset

A trove's locked rate moves with the NFT. That matters only if the global rate changes, so with the rate flat the value of a position is its equity plus any guardian reserve in the vault, and a sale price should reflect that. The sell panel's price estimate does exactly this: it adds a rate advantage only when the locked rate is below the market, and says there is no premium otherwise.

## Revenue model

One source, and it earns nothing yet.

- **What:** a fee on each marketplace sale. 25 bps (0.25%) of the sale price, rounded up. The contract refuses to deploy with more than 100 bps (1%).
- **Who pays:** the seller, in effect. The buyer pays the listed price and the contract splits it: the seller receives the price minus the fee, and the fee goes to the fee recipient. A 2,000 MUSD sale carries a fee of 5 MUSD. That is arithmetic, not a projection.
- **Who receives:** one address, fixed in the contract's constructor. There is no owner and no setter, so the rate can neither be raised later nor redirected. On the testnet deployment it is the deployer address.
- **Nothing else.** The keeper tip goes to the keeper, not to Trozu. There is no token, no subscription and no fee on opening, closing, transferring or the guardian.
- **What it has earned.** Mainnet: nothing. Testnet: the team's own wallets ran 3 sales for 315.67 MUSD of volume and 0.79 MUSD of fee, paid to the team's own deployer address. That is test traffic, not revenue (the live numbers are on [/stats](https://keel-two-roan.vercel.app/stats)).

## What happens if rates stay flat

They have for the whole life of the chain, so this is the case to plan for.

- **The rate premium is zero.** A locked rate equal to the market rate adds nothing to a position's price. Refinancing saves nothing. The app shows no premium rather than inventing one.
- **Redemption defense is unaffected.** It depends on collateral ratio and the redemption queue, not on the rate.
- **The marketplace has to stand on handing over a position without closing it.** For a seller the alternative is repaying, closing and having the buyer open a new trove. Whether enough people want to buy a debt position for that to be worth a fee is untested.
- **Revenue stays near zero** unless sales happen. At 25 bps even steady sales are small money: the fee is 0.0025 of volume. Trozu should be judged on whether the defense and the transfer are useful, not on that fee.

## Who uses this first

None of this is observed: I have not interviewed anyone and the only users so far are the team's own wallets. These are hypotheses, in the order the data supports them.

1. **A holder of a trove near the front of the redemption queue who cannot watch the chain.** The redemption volume is evidence the event is common. Today the mainnet book has 3 troves, so the number of possible first users is very small, and one of them holds most of the debt.
2. **Someone moving a position between wallets or entities** (a team handing a position to a treasury, a person to a new wallet). Transfer needs no buyer and no fee.
3. **A keeper**, who earns the tip. Whether the tip covers gas on mainnet has not been measured.
4. **A buyer of a position**, last, because it needs a seller first and a price both sides accept.

## Honest competition and alternatives

- **Mezo's own tools.** Mezo's app is where troves are opened, adjusted and closed, and a borrower can top up by hand. I have not audited every feature of it, so any claim that it lacks a feature is unchecked. Trozu adds transfer, sale and a standing defense on top of the same contracts. If Mezo adds transferable positions or auto-protection, the overlap is direct.
- **Doing it by hand or with a generic bot.** A competent operator may not need the guardian. Its value is that anyone can trigger it inside bounds the holder set, with an explicit reserve and a cap on what a keeper can take, so the holder runs no infrastructure.
- **Closing and reopening.** The status quo for a seller. It costs fees, and the locked rate, which is worth nothing while the rate is flat.
- **Other projects.** I have not reviewed other submissions and make no comparison.

## What would change this assessment

- A rate proposal from governance would make locked rates, and so position pricing, meaningful.
- A mainnet book that stays at three troves is a small market for any product built on positions. The data cannot say whether the stock grows.
- A real user who sets a policy, or a real buyer, would change "hypothesis" to evidence. None exists yet.

## User feedback

None collected yet. This section is filled from real replies only, with their words, not mine. Nothing below is a quote until a row is filled in.

| Date | How I reached them | Who they are (role, not name unless they agree) | What they said, verbatim | What I did about it, or why not |
|---|---|---|---|---|
| [date] | [channel] | [e.g. trove holder, keeper, builder] | "[verbatim reply]" | [change made, or reason it was not] |
| [date] | [channel] | [role] | "[verbatim reply]" | [action] |
| [date] | [channel] | [role] | "[verbatim reply]" | [action] |

Questions to ask, so replies are comparable: Do you watch your trove's ratio today, and how? Have you been redeemed against? Would you fund a reserve for a guardian, and how much would you trust a stranger to trigger it? Would you buy someone else's debt position, and what would you want to see first?

## Status and limits

- Testnet only. Not audited. The review in [REVIEW.md](REVIEW.md) is AI-assisted, not an independent audit.
- Nothing is deployed on Mezo mainnet.
- Reading the order book means scanning logs in 10,000-block windows on Mezo's public RPC.
