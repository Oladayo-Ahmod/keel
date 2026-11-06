// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TrozuNFT} from "./TrozuNFT.sol";
import {PositionLens} from "../PositionLens.sol";
import {MezoCore} from "../MezoCore.sol";
import {
    IBorrowerOperations,
    ITroveManager,
    IInterestRateManager,
    IPriceFeed,
    IMUSD
} from "../interfaces/mezo/IMezo.sol";

interface IMinNetDebt {
    function minNetDebt() external view returns (uint256);
}

interface ITotalCollRatio {
    function getTCR(uint256 price) external view returns (uint256);
}

/// One MUSD trove, owned by this contract and controlled by whoever holds the
/// position NFT. Deployed as an EIP-1167 clone by the factory.
///
/// Everything the Wave 1 vault does is here unchanged in behaviour. On top of it:
///
///  * a reserve of BTC and MUSD that belongs to the holder, is accounted for
///    explicitly and can be withdrawn at any time, and
///  * a guardian: a policy the holder sets, which anyone may trigger through
///    `execute()`. The guardian can only move reserve funds into the trove (top up
///    collateral or repay) and only inside the bounds of the policy. It never
///    refinances, never borrows and never sends reserve funds anywhere but the
///    trove and the capped keeper tip.
///
/// Authority is `nft.ownerOf(tokenId)` at call time. A policy is stamped with the
/// NFT's `transferEpoch` and stops applying the moment the token moves.
contract TrozuVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IMUSD;

    uint256 internal constant GAS_COMPENSATION = 200e18;
    uint256 internal constant MCR = 1.1e18;

    /// Hard limits baked into the code, whatever a policy says.
    uint256 public constant MAX_KEEPER_TIP = 1e14; // 0.0001 BTC
    uint256 public constant MAX_WALK_STEPS = 100;
    uint256 public constant MAX_TARGET_ICR = 5e18;
    uint256 public constant MIN_PERIOD = 1 hours;
    uint256 public constant MAX_PERIOD = 30 days;

    address public immutable FACTORY;
    TrozuNFT public immutable NFT;
    PositionLens public immutable LENS;
    IBorrowerOperations public immutable BORROWER_OPERATIONS;
    ITroveManager public immutable TROVE_MANAGER;
    IInterestRateManager public immutable INTEREST_RATE_MANAGER;
    IPriceFeed public immutable PRICE_FEED;
    address public immutable COLL_SURPLUS_POOL;
    address public immutable ACTIVE_POOL;
    IMUSD public immutable MUSD;
    /// Ceiling on the position's total debt when debt is added. 0 means no cap.
    uint256 public immutable DEBT_CAP;

    uint256 public tokenId;
    bool public initialized;

    /// Funds the holder parked here for the guardian. The vault holds exactly
    /// these amounts (plus anything forced in, which `sweep` returns) between calls.
    uint256 public reserveBtc;
    uint256 public reserveMusd;

    struct Policy {
        uint256 epoch; // set by the vault, ignored on input
        uint256 floorIcr; // act when the ratio is below this (1e18 = 100%)
        uint256 targetIcr; // restore towards this ratio, never push further than needed
        uint256 maxActionBtc; // per action
        uint256 maxActionMusd; // per action
        uint256 periodCapBtc; // total BTC that may leave the reserve per period, tip included
        uint256 periodCapMusd;
        uint256 keeperTipBtc; // paid from the reserve on success, at most MAX_KEEPER_TIP
        uint256 bufferFloorMusd; // redemption defense: act when the buffer is below this. 0 turns it off
        uint32 period; // seconds
        uint16 maxWalkSteps; // how far a redemption-buffer walk may go
        bool active; // set by the vault, ignored on input
    }

    enum Kind {
        None,
        TopUpBtc,
        RepayMusd,
        DefendBtc
    }

    enum Reason {
        None,
        NoPolicy,
        PolicyStale,
        TroveInactive,
        NoPrice,
        Healthy,
        BufferUnknown,
        NoReserve,
        BelowMinimum // an action would still leave the ratio under 110%, which Mezo refuses in normal mode
    }

    struct Plan {
        Kind kind;
        Reason reason;
        uint256 amount;
        uint256 tip;
        uint256 icr;
        bool resetWindow;
    }

    Policy internal _policy;
    uint64 public periodStart;
    uint256 public spentBtc; // this period, tip included
    uint256 public spentMusd;

    event Opened(address indexed holder, uint256 debt, uint256 collateral);
    event CollateralAdded(address indexed holder, uint256 amount);
    event CollateralWithdrawn(address indexed holder, uint256 amount);
    event Borrowed(address indexed holder, uint256 amount);
    event Repaid(address indexed holder, uint256 amount);
    event Adjusted(address indexed holder);
    event Refinanced(address indexed holder, uint16 oldRate, uint16 newRate, uint256 fee);
    event Closed(address indexed holder, uint256 collateral);
    event SurplusClaimed(address indexed holder, uint256 amount);
    event Swept(address indexed holder, address indexed token, uint256 amount);
    event ReserveFunded(address indexed holder, address indexed asset, uint256 amount);
    event ReserveWithdrawn(address indexed holder, address indexed asset, uint256 amount);
    event PolicySet(address indexed holder, uint256 epoch, Policy policy);
    event PolicyCleared(address indexed holder);
    event GuardianAction(address indexed keeper, Kind kind, uint256 amount, uint256 tip, uint256 icrBefore);

    error NotHolder();
    error OnlyFactory();
    error AlreadyInitialized();
    error UnexpectedSender();
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    error NoRateImprovement(uint16 lockedRate, uint16 globalRate);
    error RefinanceFeeTooHigh(uint256 fee, uint256 maxFee);
    error RateNotUpdated(uint16 expected, uint16 actual);
    error BtcTransferFailed();
    error DebtCapExceeded(uint256 debt, uint256 cap);
    error ReserveTooSmall(uint256 requested, uint256 available);
    error BadPolicy(string why);
    error NothingToDo(Reason reason);
    error ReserveInvariant();

    modifier onlyHolder() {
        if (NFT.ownerOf(tokenId) != msg.sender) revert NotHolder();
        _;
    }

    constructor(address factory, address nft, address lens, MezoCore memory core, uint256 debtCap) {
        FACTORY = factory;
        NFT = TrozuNFT(nft);
        LENS = PositionLens(lens);
        BORROWER_OPERATIONS = IBorrowerOperations(core.borrowerOperations);
        TROVE_MANAGER = ITroveManager(core.troveManager);
        INTEREST_RATE_MANAGER = IInterestRateManager(core.interestRateManager);
        PRICE_FEED = IPriceFeed(core.priceFeed);
        COLL_SURPLUS_POOL = core.collSurplusPool;
        ACTIVE_POOL = core.activePool;
        MUSD = IMUSD(core.musd);
        DEBT_CAP = debtCap;
        // the implementation itself is never a usable vault
        initialized = true;
    }

    /// Mezo pays collateral out with a raw call, so accept it from the two pools
    /// that do and nothing else. Reserve BTC comes in through `fundReserveBtc`.
    receive() external payable {
        if (msg.sender != ACTIVE_POOL && msg.sender != COLL_SURPLUS_POOL) revert UnexpectedSender();
    }

    // ------------------------------------------------------------------
    // Wave 1 surface
    // ------------------------------------------------------------------

    /// First open, called by the factory in the same transaction as the clone.
    /// The NFT does not exist yet, so the holder is passed in.
    function initializeAndOpen(
        uint256 id,
        address holder,
        uint256 debt,
        address upperHint,
        address lowerHint,
        uint256 maxFee
    ) external payable nonReentrant {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        tokenId = id;
        _open(holder, debt, upperHint, lowerHint, maxFee);
    }

    /// Reopen after the trove was closed, redeemed or liquidated.
    function open(uint256 debt, address upperHint, address lowerHint, uint256 maxFee)
        external
        payable
        nonReentrant
        onlyHolder
    {
        _open(msg.sender, debt, upperHint, lowerHint, maxFee);
    }

    function addCollateral(address upperHint, address lowerHint) external payable nonReentrant onlyHolder {
        BORROWER_OPERATIONS.addColl{value: msg.value}(upperHint, lowerHint);
        emit CollateralAdded(msg.sender, msg.value);
    }

    function withdrawCollateral(uint256 amount, address upperHint, address lowerHint)
        external
        nonReentrant
        onlyHolder
    {
        uint256 btcBefore = address(this).balance;
        BORROWER_OPERATIONS.withdrawColl(amount, upperHint, lowerHint);
        _forwardBtc(btcBefore);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount, address upperHint, address lowerHint, uint256 maxFee)
        external
        nonReentrant
        onlyHolder
    {
        _checkFee(amount, maxFee);
        uint256 musdBefore = MUSD.balanceOf(address(this));
        BORROWER_OPERATIONS.withdrawMUSD(amount, upperHint, lowerHint);
        _forwardMusd(musdBefore);
        _checkCap();
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount, address upperHint, address lowerHint) external nonReentrant onlyHolder {
        _repay(amount, upperHint, lowerHint);
    }

    /// Same as repay, with an EIP-2612 signature for the MUSD pull. The permit is
    /// a convenience only: if someone front-runs it the allowance is already set,
    /// so a failure is ignored and the transfer decides.
    function repayWithPermit(
        uint256 amount,
        address upperHint,
        address lowerHint,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant onlyHolder {
        try MUSD.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _repay(amount, upperHint, lowerHint);
    }

    /// Combined collateral and debt change, same shape as Mezo's adjustTrove.
    function adjust(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint,
        uint256 maxFee
    ) external payable nonReentrant onlyHolder {
        uint256 btcBefore = address(this).balance - msg.value;
        uint256 musdBefore = MUSD.balanceOf(address(this));
        if (isDebtIncrease) {
            _checkFee(debtChange, maxFee);
        } else if (debtChange > 0) {
            MUSD.safeTransferFrom(msg.sender, address(this), debtChange);
        }
        BORROWER_OPERATIONS.adjustTrove{value: msg.value}(
            collWithdrawal, debtChange, isDebtIncrease, upperHint, lowerHint
        );
        _forwardBtc(btcBefore);
        _forwardMusd(musdBefore);
        if (isDebtIncrease) _checkCap();
        emit Adjusted(msg.sender);
    }

    /// Move the trove to the current global rate, but only if that is lower by at
    /// least `minRateDropBps` (never less than one) and the fee stays under
    /// `maxFee`. Mezo itself would also move a trove to a higher rate. Manual only:
    /// the guardian never calls this.
    function refinance(address upperHint, address lowerHint, uint256 maxFee, uint16 minRateDropBps)
        external
        nonReentrant
        onlyHolder
    {
        uint16 lockedRate = TROVE_MANAGER.getTroveInterestRate(address(this));
        uint16 globalRate = INTEREST_RATE_MANAGER.interestRate();
        uint256 minDrop = minRateDropBps == 0 ? 1 : minRateDropBps;
        if (uint256(globalRate) + minDrop > lockedRate) revert NoRateImprovement(lockedRate, globalRate);

        uint256 debtBefore = _totalDebt();
        BORROWER_OPERATIONS.refinance(upperHint, lowerHint);
        uint256 fee = _totalDebt() - debtBefore;
        if (fee > maxFee) revert RefinanceFeeTooHigh(fee, maxFee);

        uint16 newRate = TROVE_MANAGER.getTroveInterestRate(address(this));
        if (newRate != globalRate) revert RateNotUpdated(globalRate, newRate);
        emit Refinanced(msg.sender, lockedRate, newRate, fee);
    }

    /// Repays the whole debt except the 200 MUSD gas reserve, which Mezo burns
    /// from its own pool, and sends the collateral to the holder.
    function close() external nonReentrant onlyHolder {
        _close();
    }

    function closeWithPermit(uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant onlyHolder {
        try MUSD.permit(msg.sender, address(this), _closeCost(), deadline, v, r, s) {} catch {}
        _close();
    }

    /// Collateral a redemption or liquidation left in the surplus pool.
    function claimSurplus() external nonReentrant onlyHolder {
        uint256 btcBefore = address(this).balance;
        BORROWER_OPERATIONS.claimCollateral();
        uint256 amount = address(this).balance - btcBefore;
        _forwardBtc(btcBefore);
        emit SurplusClaimed(msg.sender, amount);
    }

    /// Return anything that landed here outside a normal flow, for example a
    /// forced BTC send or a token sent by mistake. Zero address means BTC. The
    /// reserve is not swept: it is withdrawn with the reserve functions.
    function sweep(address token) external nonReentrant onlyHolder {
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance - reserveBtc;
            if (amount > 0) {
                (bool ok,) = msg.sender.call{value: amount}("");
                if (!ok) revert BtcTransferFailed();
            }
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (token == address(MUSD)) amount -= reserveMusd;
            if (amount > 0) IERC20(token).safeTransfer(msg.sender, amount);
        }
        emit Swept(msg.sender, token, amount);
    }

    // ------------------------------------------------------------------
    // Reserve
    // ------------------------------------------------------------------

    function fundReserveBtc() external payable nonReentrant onlyHolder {
        reserveBtc += msg.value;
        emit ReserveFunded(msg.sender, address(0), msg.value);
    }

    function fundReserveMusd(uint256 amount) external nonReentrant onlyHolder {
        _fundMusd(amount);
    }

    function fundReserveMusdWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        onlyHolder
    {
        try MUSD.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _fundMusd(amount);
    }

    /// Withdrawable at any time, whatever the policy says.
    function withdrawReserveBtc(uint256 amount) external nonReentrant onlyHolder {
        if (amount > reserveBtc) revert ReserveTooSmall(amount, reserveBtc);
        reserveBtc -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BtcTransferFailed();
        emit ReserveWithdrawn(msg.sender, address(0), amount);
    }

    function withdrawReserveMusd(uint256 amount) external nonReentrant onlyHolder {
        if (amount > reserveMusd) revert ReserveTooSmall(amount, reserveMusd);
        reserveMusd -= amount;
        IERC20(address(MUSD)).safeTransfer(msg.sender, amount);
        emit ReserveWithdrawn(msg.sender, address(MUSD), amount);
    }

    // ------------------------------------------------------------------
    // Guardian
    // ------------------------------------------------------------------

    /// Holder only. Replaces any earlier policy and restarts the period.
    function setPolicy(Policy calldata p) external nonReentrant onlyHolder {
        if (p.floorIcr <= MCR) revert BadPolicy("floor must be above the 110% minimum");
        if (p.targetIcr <= p.floorIcr) revert BadPolicy("target must be above floor");
        if (p.targetIcr > MAX_TARGET_ICR) revert BadPolicy("target above 500%");
        if (p.period < MIN_PERIOD || p.period > MAX_PERIOD) revert BadPolicy("period out of range");
        if (p.keeperTipBtc > MAX_KEEPER_TIP) revert BadPolicy("tip above cap");
        if (p.maxActionBtc == 0 && p.maxActionMusd == 0) revert BadPolicy("no action allowed");
        if (p.maxActionBtc > p.periodCapBtc || p.maxActionMusd > p.periodCapMusd) {
            revert BadPolicy("action cap above period cap");
        }
        if (p.keeperTipBtc > 0 && p.keeperTipBtc >= p.periodCapBtc) revert BadPolicy("tip not below period cap");
        if (p.maxWalkSteps > MAX_WALK_STEPS) revert BadPolicy("walk too long");
        if (p.bufferFloorMusd > 0 && (p.maxWalkSteps == 0 || p.maxActionBtc == 0)) {
            revert BadPolicy("defense needs a walk and a BTC cap");
        }

        uint256 epoch = NFT.transferEpoch(tokenId);
        _policy = Policy({
            epoch: epoch,
            floorIcr: p.floorIcr,
            targetIcr: p.targetIcr,
            maxActionBtc: p.maxActionBtc,
            maxActionMusd: p.maxActionMusd,
            periodCapBtc: p.periodCapBtc,
            periodCapMusd: p.periodCapMusd,
            keeperTipBtc: p.keeperTipBtc,
            bufferFloorMusd: p.bufferFloorMusd,
            period: p.period,
            maxWalkSteps: p.maxWalkSteps,
            active: true
        });
        periodStart = 0;
        spentBtc = 0;
        spentMusd = 0;
        emit PolicySet(msg.sender, epoch, _policy);
    }

    function clearPolicy() external nonReentrant onlyHolder {
        delete _policy;
        emit PolicyCleared(msg.sender);
    }

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    /// True only if a policy exists and was set under the current holder.
    function policyLive() public view returns (bool) {
        return _policy.active && _policy.epoch == NFT.transferEpoch(tokenId);
    }

    /// What `execute` would do right now. Same code path as the real call.
    function preview() external view returns (Plan memory) {
        return _plan();
    }

    /// Anyone may call. Moves reserve funds into the trove if, and only if, the
    /// policy says so. Hints are untrusted: Mezo only uses them as a starting
    /// point for the sorted-list search. Reverts with `NothingToDo` otherwise, so a
    /// keeper that is too early pays gas and nothing else.
    function execute(address upperHint, address lowerHint)
        external
        nonReentrant
        returns (Kind kind, uint256 amount, uint256 tip)
    {
        Plan memory r = _plan();
        if (r.kind == Kind.None) revert NothingToDo(r.reason);
        kind = r.kind;
        amount = r.amount;
        tip = r.tip;

        if (r.resetWindow) {
            periodStart = uint64(block.timestamp);
            spentBtc = 0;
            spentMusd = 0;
        }

        // effects first
        if (kind == Kind.RepayMusd) {
            reserveMusd -= amount;
            spentMusd += amount;
            reserveBtc -= tip;
            spentBtc += tip;
        } else {
            reserveBtc -= amount + tip;
            spentBtc += amount + tip;
        }
        emit GuardianAction(msg.sender, kind, amount, tip, r.icr);

        // interactions
        if (kind == Kind.RepayMusd) {
            BORROWER_OPERATIONS.repayMUSD(amount, upperHint, lowerHint);
        } else {
            BORROWER_OPERATIONS.addColl{value: amount}(upperHint, lowerHint);
        }
        if (tip > 0) {
            (bool ok,) = msg.sender.call{value: tip}("");
            if (!ok) revert BtcTransferFailed();
        }

        // the reserve is backed by real balance
        if (address(this).balance < reserveBtc || MUSD.balanceOf(address(this)) < reserveMusd) {
            revert ReserveInvariant();
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    // what the guardian needs to know about the position and this period's allowance
    struct Snap {
        uint256 price;
        uint256 coll;
        uint256 debt;
        uint256 icr;
        uint256 remBtc;
        uint256 remMusd;
        uint256 tip;
        bool fresh;
        uint256 minIcr; // the ratio an action must reach: 110%, or the system ratio in recovery mode
    }

    function _plan() internal view returns (Plan memory r) {
        Policy memory p = _policy;
        if (!p.active) return _none(r, Reason.NoPolicy);
        if (p.epoch != NFT.transferEpoch(tokenId)) return _none(r, Reason.PolicyStale);
        if (TROVE_MANAGER.getTroveStatus(address(this)) != ITroveManager.Status.active) {
            return _none(r, Reason.TroveInactive);
        }

        Snap memory s;
        bool ok;
        (ok, s.price) = _price();
        if (!ok) return _none(r, Reason.NoPrice);
        s.minIcr = MCR;
        if (TROVE_MANAGER.checkRecoveryMode(s.price)) {
            // Mezo accepts any pure top-up in recovery mode, but a trove under the system ratio can
            // still be liquidated there, so money added to it is money handed to the liquidator.
            uint256 tcr = ITotalCollRatio(address(TROVE_MANAGER)).getTCR(s.price);
            if (tcr > s.minIcr) s.minIcr = tcr;
        }
        {
            (uint256 c, uint256 principal, uint256 interest,,,) = TROVE_MANAGER.getEntireDebtAndColl(address(this));
            s.coll = c;
            s.debt = principal + interest;
        }
        if (s.debt == 0) return _none(r, Reason.Healthy);
        s.icr = s.coll * s.price / s.debt;
        r.icr = s.icr;

        bool belowFloor = s.icr < p.floorIcr;
        if (s.icr >= p.targetIcr || (!belowFloor && p.bufferFloorMusd == 0)) return _none(r, Reason.Healthy);

        if (!belowFloor) {
            // redemption defense: only a complete walk that proves a low buffer may act
            (PositionLens.Verdict v,) = LENS.bufferAtLeast(tokenId, p.bufferFloorMusd, p.maxWalkSteps);
            if (v != PositionLens.Verdict.Below) {
                return _none(r, v == PositionLens.Verdict.Above ? Reason.Healthy : Reason.BufferUnknown);
            }
        }

        s.fresh = block.timestamp >= uint256(periodStart) + p.period;
        r.resetWindow = s.fresh;
        s.remBtc = _sub(p.periodCapBtc, s.fresh ? 0 : spentBtc);
        s.remMusd = _sub(p.periodCapMusd, s.fresh ? 0 : spentMusd);
        s.tip = (reserveBtc >= p.keeperTipBtc && s.remBtc >= p.keeperTipBtc) ? p.keeperTipBtc : 0;

        // An action is offered only if it leaves the trove at or above `minIcr`. In normal mode
        // Mezo would revert anything under 110%; in recovery mode it would accept the action but a
        // trove still under the system ratio can be liquidated, which would take the reserve.
        bool blocked;

        // BTC first
        uint256 amt = _btcAmount(p, s);
        if (amt > 0) {
            if ((s.coll + amt) * s.price / s.debt >= s.minIcr) {
                r.kind = belowFloor ? Kind.TopUpBtc : Kind.DefendBtc;
                r.amount = amt;
                r.tip = s.tip;
                return r;
            }
            blocked = true;
        }

        // then a MUSD repay, only for the ratio floor
        if (belowFloor) {
            amt = _repayAmount(p, s);
            if (amt > 0) {
                if (s.coll * s.price / (s.debt - amt) >= s.minIcr) {
                    r.kind = Kind.RepayMusd;
                    r.amount = amt;
                    r.tip = s.tip;
                    return r;
                }
                blocked = true;
            }
        }
        return _none(r, blocked ? Reason.BelowMinimum : Reason.NoReserve);
    }

    // BTC to add: what restores the target ratio, within the reserve, the period allowance and the per-action cap
    function _btcAmount(Policy memory p, Snap memory s) internal view returns (uint256) {
        uint256 room = _min(_min(reserveBtc - s.tip, s.remBtc - s.tip), p.maxActionBtc);
        uint256 need = _ceilDiv(p.targetIcr * s.debt, s.price) - s.coll; // positive: ratio is below target
        return _min(room, need);
    }

    // MUSD to repay: what restores the target ratio, within the reserve, the allowance, the
    // per-action cap, and what Mezo allows (net debt may not fall below its minimum)
    function _repayAmount(Policy memory p, Snap memory s) internal view returns (uint256) {
        uint256 minDebt = IMinNetDebt(address(BORROWER_OPERATIONS)).minNetDebt() + GAS_COMPENSATION;
        uint256 room = _min(_min(reserveMusd, s.remMusd), p.maxActionMusd);
        room = _min(room, _sub(s.debt, minDebt));
        return _min(room, _sub(s.debt, s.coll * s.price / p.targetIcr));
    }
    function _none(Plan memory r, Reason why) internal pure returns (Plan memory) {
        r.kind = Kind.None;
        r.reason = why;
        return r;
    }

    function _fundMusd(uint256 amount) internal {
        MUSD.safeTransferFrom(msg.sender, address(this), amount);
        reserveMusd += amount;
        emit ReserveFunded(msg.sender, address(MUSD), amount);
    }

    function _open(address to, uint256 debt, address upperHint, address lowerHint, uint256 maxFee) internal {
        _checkFee(debt, maxFee);
        uint256 musdBefore = MUSD.balanceOf(address(this));
        BORROWER_OPERATIONS.openTrove{value: msg.value}(debt, upperHint, lowerHint);
        uint256 minted = MUSD.balanceOf(address(this)) - musdBefore;
        if (minted > 0) IERC20(address(MUSD)).safeTransfer(to, minted);
        _checkCap();
        emit Opened(to, debt, msg.value);
    }

    function _repay(uint256 amount, address upperHint, address lowerHint) internal {
        uint256 musdBefore = MUSD.balanceOf(address(this));
        MUSD.safeTransferFrom(msg.sender, address(this), amount);
        BORROWER_OPERATIONS.repayMUSD(amount, upperHint, lowerHint);
        _forwardMusd(musdBefore);
        emit Repaid(msg.sender, amount);
    }

    function _close() internal {
        uint256 cost = _closeCost();
        uint256 musdBefore = MUSD.balanceOf(address(this));
        uint256 btcBefore = address(this).balance;
        MUSD.safeTransferFrom(msg.sender, address(this), cost);
        BORROWER_OPERATIONS.closeTrove();
        uint256 collateral = address(this).balance - btcBefore;
        _forwardBtc(btcBefore);
        _forwardMusd(musdBefore);
        emit Closed(msg.sender, collateral);
    }

    function _closeCost() internal view returns (uint256) {
        return _totalDebt() - GAS_COMPENSATION;
    }

    // principal + interest, including accrued interest and pending redistribution
    function _totalDebt() internal view returns (uint256) {
        (, uint256 principal, uint256 interest,,,) = TROVE_MANAGER.getEntireDebtAndColl(address(this));
        return principal + interest;
    }

    function _checkCap() internal view {
        if (DEBT_CAP == 0) return;
        uint256 debt = _totalDebt();
        if (debt > DEBT_CAP) revert DebtCapExceeded(debt, DEBT_CAP);
    }

    function _checkFee(uint256 debt, uint256 maxFee) internal view {
        uint256 fee = BORROWER_OPERATIONS.getBorrowingFee(debt);
        if (fee > maxFee) revert FeeTooHigh(fee, maxFee);
    }

    function _price() internal view returns (bool ok, uint256 price) {
        try PRICE_FEED.fetchPrice() returns (uint256 p) {
            return (p > 0, p);
        } catch {
            return (false, 0);
        }
    }

    // send what arrived since `before` to the caller
    function _forwardBtc(uint256 before) internal {
        uint256 amount = address(this).balance - before;
        if (amount == 0) return;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BtcTransferFailed();
    }

    function _forwardMusd(uint256 before) internal {
        uint256 amount = MUSD.balanceOf(address(this)) - before;
        if (amount > 0) IERC20(address(MUSD)).safeTransfer(msg.sender, amount);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
