// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TrozuNFT} from "./TrozuNFT.sol";
import {ITroveManager} from "../interfaces/mezo/IMezo.sol";

/// Peer to peer sale of Trozu positions for MUSD.
///
/// A seller signs a listing off chain (EIP-712, or ERC-1271 for a contract
/// wallet). The position stays in the seller's wallet until a buyer settles.
/// Settlement is one transaction: it re-reads the trove from Mezo, checks it
/// against bounds the buyer chose, moves MUSD and then the NFT. If any check
/// fails nothing moves.
///
/// No owner, no setters. The fee and its recipient are fixed at deployment and
/// the fee can never exceed MAX_FEE_BPS.
contract TrozuMarket is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 100; // 1%
    uint256 internal constant BPS = 10_000;

    bytes32 public constant LISTING_TYPEHASH = keccak256(
        "Listing(address seller,uint256 tokenId,uint256 epoch,uint256 startPrice,uint256 endPrice,"
        "uint64 startTime,uint64 endTime,uint64 deadline,uint256 nonce,uint256 salt)"
    );

    TrozuNFT public immutable NFT;
    IERC20 public immutable MUSD;
    ITroveManager public immutable TROVE_MANAGER;
    address public immutable FEE_RECIPIENT;
    uint16 public immutable FEE_BPS;

    /// A listing. `epoch` is the NFT's transferEpoch when it was signed and `nonce`
    /// is the seller's `sellerNonce` at that time, so a transfer or `cancelAll`
    /// kills it. `endPrice == startPrice` is a fixed price. Otherwise the price
    /// falls in a straight line from startPrice at startTime to endPrice at
    /// endTime and stays at endPrice until `deadline`.
    struct Listing {
        address seller;
        uint256 tokenId;
        uint256 epoch;
        uint256 startPrice;
        uint256 endPrice;
        uint64 startTime;
        uint64 endTime;
        uint64 deadline;
        uint256 nonce;
        uint256 salt;
    }

    /// What the buyer insists on. Checked against Mezo's numbers in the same
    /// transaction as the payment.
    struct Bounds {
        uint256 expectedEpoch;
        uint256 minColl;
        uint256 maxDebt;
        uint16 minRateBps;
        uint16 maxRateBps;
        uint256 maxPrice;
    }

    /// Optional EIP-2612 signature for MUSD. `deadline == 0` skips it.
    struct PermitData {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    enum State {
        Ok,
        Filled,
        Cancelled,
        BadParams,
        NotStarted,
        Expired,
        NonceRevoked,
        BadSignature,
        NotOwner,
        NotApproved,
        StaleEpoch,
        TroveInactive,
        NoCollateral
    }

    enum Status {
        Open,
        Filled,
        Cancelled
    }

    mapping(bytes32 => Status) public status;
    mapping(address => uint256) public sellerNonce;

    event ListingAnnounced(bytes32 indexed hash, address indexed seller, uint256 indexed tokenId, Listing listing, bytes signature);
    event ListingCancelled(bytes32 indexed hash, address indexed seller, uint256 indexed tokenId);
    event AllListingsCancelled(address indexed seller, uint256 newNonce);
    event Sold(
        bytes32 indexed hash,
        address indexed seller,
        address indexed buyer,
        uint256 tokenId,
        address recipient,
        uint256 price,
        uint256 fee
    );

    error ListingInvalid(State state);
    error NotSeller();
    error AlreadyClosed();
    error EpochMismatch(uint256 expected, uint256 actual);
    error CollateralBelowMin(uint256 actual, uint256 min);
    error DebtAboveMax(uint256 actual, uint256 max);
    error RateOutOfRange(uint16 actual, uint16 min, uint16 max);
    error PriceAboveMax(uint256 price, uint256 max);
    error FeeTooHigh();
    error ZeroAddress();

    constructor(address nft, address musd, address troveManager, address feeRecipient, uint16 feeBps)
        EIP712("TrozuMarket", "1")
    {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient == address(0) || nft == address(0) || musd == address(0) || troveManager == address(0)) {
            revert ZeroAddress();
        }
        NFT = TrozuNFT(nft);
        MUSD = IERC20(musd);
        TROVE_MANAGER = ITroveManager(troveManager);
        FEE_RECIPIENT = feeRecipient;
        FEE_BPS = feeBps;
    }

    // ------------------------------------------------------------------
    // views
    // ------------------------------------------------------------------

    function hashListing(Listing calldata l) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LISTING_TYPEHASH,
                    l.seller,
                    l.tokenId,
                    l.epoch,
                    l.startPrice,
                    l.endPrice,
                    l.startTime,
                    l.endTime,
                    l.deadline,
                    l.nonce,
                    l.salt
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// Price at time `t`. Falls in a straight line, the drop is rounded down, so
    /// the price is rounded up in the buyer's disfavour.
    function priceAt(Listing calldata l, uint256 t) public pure returns (uint256) {
        if (l.startPrice == l.endPrice || t <= l.startTime) return l.startPrice;
        if (t >= l.endTime) return l.endPrice;
        uint256 drop = (l.startPrice - l.endPrice) * (t - l.startTime) / (l.endTime - l.startTime);
        return l.startPrice - drop;
    }

    /// Fee on a price, rounded up. The seller receives `price - fee`, so the
    /// seller's side is the one rounded down.
    function feeOn(uint256 price) public view returns (uint256) {
        return (price * FEE_BPS + BPS - 1) / BPS;
    }

    /// Everything that can stop a listing from settling right now, in one place.
    /// Used by `buy`, by `announce` and by the app to explain a refusal.
    function check(Listing calldata l, bytes calldata signature) public view returns (State) {
        bytes32 hash = hashListing(l);
        Status s = status[hash];
        if (s == Status.Filled) return State.Filled;
        if (s == Status.Cancelled) return State.Cancelled;
        if (
            l.startPrice == 0 || l.endPrice == 0 || l.endPrice > l.startPrice
                || (l.startPrice != l.endPrice && l.endTime <= l.startTime) || l.deadline <= l.startTime
        ) return State.BadParams;
        if (block.timestamp < l.startTime) return State.NotStarted;
        if (block.timestamp > l.deadline) return State.Expired;
        if (l.nonce != sellerNonce[l.seller]) return State.NonceRevoked;
        if (!SignatureChecker.isValidSignatureNow(l.seller, hash, signature)) return State.BadSignature;
        if (NFT.ownerOf(l.tokenId) != l.seller) return State.NotOwner;
        if (NFT.getApproved(l.tokenId) != address(this) && !NFT.isApprovedForAll(l.seller, address(this))) {
            return State.NotApproved;
        }
        if (NFT.transferEpoch(l.tokenId) != l.epoch) return State.StaleEpoch;
        address vault = NFT.vaultOf(l.tokenId);
        if (TROVE_MANAGER.getTroveStatus(vault) != ITroveManager.Status.active) return State.TroveInactive;
        (uint256 coll,,,,,) = TROVE_MANAGER.getEntireDebtAndColl(vault);
        if (coll == 0) return State.NoCollateral;
        return State.Ok;
    }

    // ------------------------------------------------------------------
    // seller side
    // ------------------------------------------------------------------

    /// Publish a signed listing as an event so that anyone can discover it
    /// without trusting a server. Anyone may call, but only a listing that would
    /// settle right now is accepted, so a spammer needs the seller's signature.
    function announce(Listing calldata l, bytes calldata signature) external {
        State s = check(l, signature);
        if (s != State.Ok) revert ListingInvalid(s);
        emit ListingAnnounced(hashListing(l), l.seller, l.tokenId, l, signature);
    }

    /// Cancel one listing. For a contract wallet, the wallet makes the call.
    function cancel(Listing calldata l) external {
        if (msg.sender != l.seller) revert NotSeller();
        bytes32 hash = hashListing(l);
        if (status[hash] != Status.Open) revert AlreadyClosed();
        status[hash] = Status.Cancelled;
        emit ListingCancelled(hash, l.seller, l.tokenId);
    }

    /// Cancel every listing the caller has signed so far, in one call.
    function cancelAll() external {
        uint256 n = ++sellerNonce[msg.sender];
        emit AllListingsCancelled(msg.sender, n);
    }

    // ------------------------------------------------------------------
    // buyer side
    // ------------------------------------------------------------------

    /// Settle a listing. The caller pays, `recipient` gets the position.
    /// Marks the listing filled before anything moves.
    function buy(
        Listing calldata l,
        bytes calldata signature,
        Bounds calldata b,
        address recipient,
        PermitData calldata permit
    ) external nonReentrant returns (uint256 price, uint256 fee) {
        State s = check(l, signature);
        if (s != State.Ok) revert ListingInvalid(s);

        _checkBounds(l, b);

        price = priceAt(l, block.timestamp);
        if (price > b.maxPrice) revert PriceAboveMax(price, b.maxPrice);
        fee = feeOn(price);

        bytes32 hash = hashListing(l);
        status[hash] = Status.Filled;

        _tryPermit(permit, b.maxPrice);

        // buyer pays `price`, split exactly into the seller's share and the fee
        MUSD.safeTransferFrom(msg.sender, l.seller, price - fee);
        if (fee > 0) MUSD.safeTransferFrom(msg.sender, FEE_RECIPIENT, fee);

        // the position moves last, and only because the payment above succeeded
        NFT.safeTransferFrom(l.seller, recipient, l.tokenId);

        emit Sold(hash, l.seller, msg.sender, l.tokenId, recipient, price, fee);
    }

    // the trove as it is in this block, not as it was when the listing was signed
    function _checkBounds(Listing calldata l, Bounds calldata b) internal view {
        if (b.expectedEpoch != l.epoch) revert EpochMismatch(b.expectedEpoch, l.epoch);
        address vault = NFT.vaultOf(l.tokenId);
        (uint256 coll, uint256 principal, uint256 interest,,,) = TROVE_MANAGER.getEntireDebtAndColl(vault);
        if (coll < b.minColl) revert CollateralBelowMin(coll, b.minColl);
        if (principal + interest > b.maxDebt) revert DebtAboveMax(principal + interest, b.maxDebt);
        uint16 rate = TROVE_MANAGER.getTroveInterestRate(vault);
        if (rate < b.minRateBps || rate > b.maxRateBps) revert RateOutOfRange(rate, b.minRateBps, b.maxRateBps);
    }

    // a convenience only: if someone front-ran the permit the allowance is already set
    function _tryPermit(PermitData calldata permit, uint256 value) internal {
        if (permit.deadline == 0) return;
        try IERC20Permit(address(MUSD)).permit(msg.sender, address(this), value, permit.deadline, permit.v, permit.r, permit.s) {}
        catch {}
    }
}
