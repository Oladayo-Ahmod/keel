// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {PositionNFT} from "./PositionNFT.sol";
import {MezoCore} from "./MezoCore.sol";
import {
    IBorrowerOperations,
    ITroveManager,
    ISortedTroves,
    IInterestRateManager,
    ICollSurplusPool,
    IPriceFeed
} from "./interfaces/mezo/IMezo.sol";

/// Read-only view of positions. Debt and collateral always come from
/// getEntireDebtAndColl, which includes accrued interest and pending
/// redistribution. The plain trove getters do not, so they are not used.
contract PositionLens {
    uint256 internal constant MCR = 1.1e18;
    uint256 internal constant GAS_COMPENSATION = 200e18;
    uint256 internal constant BPS = 10_000;

    PositionNFT public immutable NFT;
    IBorrowerOperations public immutable BORROWER_OPERATIONS;
    ITroveManager public immutable TROVE_MANAGER;
    ISortedTroves public immutable SORTED_TROVES;
    IInterestRateManager public immutable INTEREST_RATE_MANAGER;
    ICollSurplusPool public immutable COLL_SURPLUS_POOL;
    IPriceFeed public immutable PRICE_FEED;

    struct Info {
        uint256 tokenId;
        address vault;
        address holder;
        bool active;
        uint256 coll;
        uint256 principal;
        uint256 interest;
        uint256 debt;
        bool priceOk;
        uint256 price;
        uint256 icr; // type(uint256).max when there is no debt
        int256 equity; // USD, 1e18
        uint16 lockedRateBps;
        uint16 globalRateBps;
        int256 spreadBps; // global minus locked; positive means the locked rate is cheaper
        int256 annualSpreadMusd; // principal * spread, current rate only, not discounted
        uint256 claimableSurplus;
        uint256 refinanceFeeEstimate;
        bool redeemable;
        bool recoveryMode;
        bool canClose;
    }

    struct Buffer {
        uint256 buffer;
        uint256 eligibleAhead;
        uint256 steps;
        bool complete;
        bool inList;
    }

    enum Verdict {
        Unknown,
        Above,
        Below
    }

    constructor(address nft, MezoCore memory core) {
        NFT = PositionNFT(nft);
        BORROWER_OPERATIONS = IBorrowerOperations(core.borrowerOperations);
        TROVE_MANAGER = ITroveManager(core.troveManager);
        SORTED_TROVES = ISortedTroves(core.sortedTroves);
        INTEREST_RATE_MANAGER = IInterestRateManager(core.interestRateManager);
        COLL_SURPLUS_POOL = ICollSurplusPool(core.collSurplusPool);
        PRICE_FEED = IPriceFeed(core.priceFeed);
    }

    function positionsOf(address holder) external view returns (uint256[] memory ids) {
        uint256 n = NFT.balanceOf(holder);
        ids = new uint256[](n);
        for (uint256 i; i < n; i++) {
            ids[i] = NFT.tokenOfOwnerByIndex(holder, i);
        }
    }

    function positionInfo(uint256 tokenId) external view returns (Info memory info) {
        address vault = NFT.vaultOf(tokenId);
        info.tokenId = tokenId;
        info.vault = vault;
        info.holder = NFT.ownerOf(tokenId);
        info.active = TROVE_MANAGER.getTroveStatus(vault) == ITroveManager.Status.active;

        (info.coll, info.principal, info.interest,,,) = TROVE_MANAGER.getEntireDebtAndColl(vault);
        info.debt = info.principal + info.interest;

        (info.priceOk, info.price) = _price();
        if (info.priceOk) {
            info.icr = _icr(info.coll, info.debt, info.price);
            info.equity = int256(info.coll * info.price / 1e18) - int256(info.debt);
            info.recoveryMode = TROVE_MANAGER.checkRecoveryMode(info.price);
        }

        info.lockedRateBps = TROVE_MANAGER.getTroveInterestRate(vault);
        info.globalRateBps = INTEREST_RATE_MANAGER.interestRate();
        info.spreadBps = int256(uint256(info.globalRateBps)) - int256(uint256(info.lockedRateBps));
        info.annualSpreadMusd = int256(info.principal) * info.spreadBps / int256(BPS);

        info.claimableSurplus = COLL_SURPLUS_POOL.getCollateral(vault);

        if (info.active && info.debt >= GAS_COMPENSATION) {
            uint256 netDebt = info.debt - GAS_COMPENSATION;
            uint256 amount = uint256(BORROWER_OPERATIONS.refinancingFeePercentage()) * netDebt / 100;
            info.refinanceFeeEstimate = BORROWER_OPERATIONS.getBorrowingFee(amount);
        }

        info.redeemable = info.active && info.priceOk && info.icr >= MCR && SORTED_TROVES.contains(vault);
        info.canClose = info.active && info.priceOk && !info.recoveryMode && SORTED_TROVES.getSize() > 1;
    }

    /// MUSD that has to be redeemed before the position's trove is reached.
    ///
    /// If `complete` is true the walk reached the trove and `buffer` is exact for
    /// this block. If false, `buffer` is only a lower bound: it can show the
    /// buffer is large but never that it is small.
    function redemptionBuffer(uint256 tokenId, uint256 maxSteps) external view returns (Buffer memory b) {
        (b,) = _walk(NFT.vaultOf(tokenId), maxSteps, type(uint256).max);
    }

    /// Is the buffer at least `threshold`? `Above` as soon as the running sum gets
    /// there. `Below` only after a complete walk. Anything else is `Unknown`, and
    /// an on-chain trigger must not act on `Unknown`.
    function bufferAtLeast(uint256 tokenId, uint256 threshold, uint256 maxSteps)
        external
        view
        returns (Verdict verdict, Buffer memory b)
    {
        bool reached;
        (b, reached) = _walk(NFT.vaultOf(tokenId), maxSteps, threshold);
        if (reached || threshold == 0) verdict = Verdict.Above;
        else if (b.complete) verdict = Verdict.Below;
    }

    function _walk(address vault, uint256 maxSteps, uint256 threshold)
        internal
        view
        returns (Buffer memory b, bool reached)
    {
        b.inList = SORTED_TROVES.contains(vault);
        if (!b.inList) return (b, false);
        (bool ok, uint256 price) = _price();
        if (!ok) return (b, false);

        address cur = SORTED_TROVES.getLast();
        while (cur != address(0) && cur != vault && b.steps < maxSteps) {
            b.steps++;
            (uint256 coll, uint256 principal, uint256 interest,,,) = TROVE_MANAGER.getEntireDebtAndColl(cur);
            uint256 debt = principal + interest;
            if (debt >= GAS_COMPENSATION && _icr(coll, debt, price) >= MCR) {
                b.buffer += debt - GAS_COMPENSATION;
                b.eligibleAhead++;
                if (b.buffer >= threshold) return (b, true);
            }
            cur = SORTED_TROVES.getPrev(cur);
        }
        b.complete = cur == vault;
    }

    function _price() internal view returns (bool ok, uint256 price) {
        try PRICE_FEED.fetchPrice() returns (uint256 p) {
            return (p > 0, p);
        } catch {
            return (false, 0);
        }
    }

    function _icr(uint256 coll, uint256 debt, uint256 price) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        return coll * price / debt;
    }
}
