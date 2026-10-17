// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PositionNFT} from "./PositionNFT.sol";
import {MezoCore} from "./MezoCore.sol";
import {
    IBorrowerOperations,
    ITroveManager,
    IInterestRateManager,
    IMUSD
} from "./interfaces/mezo/IMezo.sol";

/// One MUSD trove, owned by this contract and controlled by whoever holds the
/// position NFT. Deployed as an EIP-1167 clone by the factory.
///
/// Authority is `nft.ownerOf(tokenId)` at call time and nothing else, so an NFT
/// transfer hands over everything and there is no stored permission to reset.
/// Funds only ever go to msg.sender.
contract PositionVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IMUSD;

    uint256 internal constant GAS_COMPENSATION = 200e18;

    address public immutable FACTORY;
    PositionNFT public immutable NFT;
    IBorrowerOperations public immutable BORROWER_OPERATIONS;
    ITroveManager public immutable TROVE_MANAGER;
    IInterestRateManager public immutable INTEREST_RATE_MANAGER;
    address public immutable COLL_SURPLUS_POOL;
    address public immutable ACTIVE_POOL;
    IMUSD public immutable MUSD;

    uint256 public tokenId;
    bool public initialized;

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

    error NotHolder();
    error OnlyFactory();
    error AlreadyInitialized();
    error UnexpectedSender();
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    error NoRateImprovement(uint16 lockedRate, uint16 globalRate);
    error RefinanceFeeTooHigh(uint256 fee, uint256 maxFee);
    error RateNotUpdated(uint16 expected, uint16 actual);
    error BtcTransferFailed();

    modifier onlyHolder() {
        if (NFT.ownerOf(tokenId) != msg.sender) revert NotHolder();
        _;
    }

    constructor(address factory, address nft, MezoCore memory core) {
        FACTORY = factory;
        NFT = PositionNFT(nft);
        BORROWER_OPERATIONS = IBorrowerOperations(core.borrowerOperations);
        TROVE_MANAGER = ITroveManager(core.troveManager);
        INTEREST_RATE_MANAGER = IInterestRateManager(core.interestRateManager);
        COLL_SURPLUS_POOL = core.collSurplusPool;
        ACTIVE_POOL = core.activePool;
        MUSD = IMUSD(core.musd);
        // the implementation itself is never a usable vault
        initialized = true;
    }

    /// Mezo pays collateral out with a raw call, so accept it from the two pools
    /// that do and nothing else. No state is touched here on purpose.
    receive() external payable {
        if (msg.sender != ACTIVE_POOL && msg.sender != COLL_SURPLUS_POOL) revert UnexpectedSender();
    }

    // ---------------------------------------------------------------------
    // opening
    // ---------------------------------------------------------------------

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

    // ---------------------------------------------------------------------
    // collateral
    // ---------------------------------------------------------------------

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

    // ---------------------------------------------------------------------
    // debt
    // ---------------------------------------------------------------------

    function borrow(uint256 amount, address upperHint, address lowerHint, uint256 maxFee)
        external
        nonReentrant
        onlyHolder
    {
        _checkFee(amount, maxFee);
        uint256 musdBefore = MUSD.balanceOf(address(this));
        BORROWER_OPERATIONS.withdrawMUSD(amount, upperHint, lowerHint);
        _forwardMusd(musdBefore);
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
        emit Adjusted(msg.sender);
    }

    // ---------------------------------------------------------------------
    // rate
    // ---------------------------------------------------------------------

    /// Move the trove to the current global rate, but only if that is lower by at
    /// least `minRateDropBps` (never less than one) and the fee stays under
    /// `maxFee`. Mezo itself would also move a trove to a higher rate.
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

    // ---------------------------------------------------------------------
    // exit
    // ---------------------------------------------------------------------

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
    /// forced BTC send or a token sent by mistake. Zero address means BTC.
    function sweep(address token) external nonReentrant onlyHolder {
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount > 0) {
                (bool ok,) = msg.sender.call{value: amount}("");
                if (!ok) revert BtcTransferFailed();
            }
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount > 0) IERC20(token).safeTransfer(msg.sender, amount);
        }
        emit Swept(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------

    function _open(address to, uint256 debt, address upperHint, address lowerHint, uint256 maxFee) internal {
        _checkFee(debt, maxFee);
        uint256 musdBefore = MUSD.balanceOf(address(this));
        BORROWER_OPERATIONS.openTrove{value: msg.value}(debt, upperHint, lowerHint);
        uint256 minted = MUSD.balanceOf(address(this)) - musdBefore;
        if (minted > 0) IERC20(address(MUSD)).safeTransfer(to, minted);
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

    function _checkFee(uint256 debt, uint256 maxFee) internal view {
        uint256 fee = BORROWER_OPERATIONS.getBorrowingFee(debt);
        if (fee > maxFee) revert FeeTooHigh(fee, maxFee);
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
}
