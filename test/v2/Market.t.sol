// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {TrozuBase} from "./TrozuBase.sol";
import {TrozuVault} from "../../src/v2/TrozuVault.sol";
import {TrozuMarket} from "../../src/v2/TrozuMarket.sol";
import {ITroveManager} from "../../src/interfaces/mezo/IMezo.sol";

/// Market behaviour, one refusal at a time.
contract MarketTest is TrozuBase {
    uint256 internal sellerKey = 0xA11CE;
    uint256 internal buyerKey = 0xB0B;
    address internal seller;
    address internal buyer;
    uint256 internal id;
    TrozuVault internal vault;

    uint256 internal constant PRICE_FIXED = 2500e18;

    function setUp() public override {
        super.setUp();
        seller = vm.addr(sellerKey);
        buyer = vm.addr(buyerKey);
        (id, vault) = _openStandard(seller);
        _fundMusd(buyer, 10_000e18);
        vm.prank(buyer);
        musd.approve(address(market), type(uint256).max);
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
    }

    // ---- helpers ----

    function _fixed(uint256 price) internal view returns (TrozuMarket.Listing memory l) {
        l = TrozuMarket.Listing({
            seller: seller,
            tokenId: id,
            epoch: nft.transferEpoch(id),
            startPrice: price,
            endPrice: price,
            startTime: 0,
            endTime: 0,
            deadline: uint64(block.timestamp + 1 days),
            nonce: market.sellerNonce(seller),
            salt: 1
        });
    }

    function _dutch(uint256 hi, uint256 lo, uint64 dur) internal view returns (TrozuMarket.Listing memory l) {
        l = _fixed(hi);
        l.endPrice = lo;
        l.startTime = uint64(block.timestamp);
        l.endTime = uint64(block.timestamp) + dur;
        l.deadline = uint64(block.timestamp) + dur + 1 days;
    }

    function _sign(uint256 key, TrozuMarket.Listing memory l) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, market.hashListing(l));
        return abi.encodePacked(r, s, v);
    }

    function _bounds(TrozuMarket.Listing memory l) internal view returns (TrozuMarket.Bounds memory b) {
        (uint256 coll, uint256 p, uint256 i,,,) = troveManager.getEntireDebtAndColl(nft.vaultOf(l.tokenId));
        b = TrozuMarket.Bounds({
            expectedEpoch: l.epoch,
            minColl: coll,
            maxDebt: p + i + 1e18,
            minRateBps: 0,
            maxRateBps: 10_000,
            maxPrice: type(uint256).max
        });
    }

    function _noPermit() internal pure returns (TrozuMarket.PermitData memory) {
        return TrozuMarket.PermitData(0, 0, 0, 0);
    }

    // Foundry's prank and expectRevert apply to the next external call, so anything that reads
    // chain state (the bounds, a signature digest) is computed before they are armed.
    function _buy(TrozuMarket.Listing memory l, bytes memory sig) internal returns (uint256 price, uint256 fee) {
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.prank(buyer);
        return market.buy(l, sig, b, buyer, _noPermit());
    }

    function _invalid(TrozuMarket.State s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TrozuMarket.ListingInvalid.selector, s);
    }

    function _buyRevert(TrozuMarket.Listing memory l, bytes memory sig, bytes memory err) internal {
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.expectRevert(err);
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
    }

    // ---- settlement ----

    function test_fixedPriceSaleMovesValueAndPosition() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);

        uint256 buyerBefore = musd.balanceOf(buyer);
        uint256 sellerBefore = musd.balanceOf(seller);
        uint256 feeBefore = musd.balanceOf(feeRecipient);
        uint256 epochBefore = nft.transferEpoch(id);
        uint256 debtBefore = _debtOf(address(vault));

        (uint256 price, uint256 fee) = _buy(l, sig);

        assertEq(price, PRICE_FIXED);
        assertEq(fee, 6.25e18); // 25 bps of 2500, exact
        assertEq(buyerBefore - musd.balanceOf(buyer), price, "buyer pays the price");
        assertEq(musd.balanceOf(seller) - sellerBefore, price - fee, "seller gets price minus fee");
        assertEq(musd.balanceOf(feeRecipient) - feeBefore, fee, "recipient gets the fee");
        assertEq(nft.ownerOf(id), buyer);
        assertEq(nft.transferEpoch(id), epochBefore + 1);
        assertEq(musd.balanceOf(address(market)), 0, "market holds nothing");
        assertEq(_debtOf(address(vault)) >= debtBefore, true);
        assertEq(uint8(market.status(market.hashListing(l))), uint8(TrozuMarket.Status.Filled));
    }

    function test_buyerCanDirectThePositionToAnotherAddress() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.prank(buyer);
        market.buy(l, sig, b, carol, _noPermit());
        assertEq(nft.ownerOf(id), carol);
    }

    function test_filledListingCannotBeReplayed() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        _buy(l, sig);
        // the new owner re-approves and the old signature is offered again
        vm.prank(buyer);
        nft.setApprovalForAll(address(market), true);
        _buyRevert(l, sig, _invalid(TrozuMarket.State.Filled));
    }

    function test_newHolderCannotBeSoldOutBySellersOldSignatureEvenAfterBuyingBack() public {
        // seller lists, someone buys, seller buys it back: the old listing is dead
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        _buy(l, sig);
        vm.prank(buyer);
        nft.transferFrom(buyer, seller, id);
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        // a fresh signature of the same terms would carry the old epoch and salt
        _buyRevert(l, sig, _invalid(TrozuMarket.State.Filled));
    }

    // ---- refusals ----

    function test_cancelledListingNeverSettles() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        vm.prank(seller);
        market.cancel(l);
        _buyRevert(l, sig, _invalid(TrozuMarket.State.Cancelled));
        assertEq(nft.ownerOf(id), seller);
    }

    function test_onlySellerCanCancel() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        vm.prank(buyer);
        vm.expectRevert(TrozuMarket.NotSeller.selector);
        market.cancel(l);
    }

    function test_cannotCancelTwice() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        vm.startPrank(seller);
        market.cancel(l);
        vm.expectRevert(TrozuMarket.AlreadyClosed.selector);
        market.cancel(l);
        vm.stopPrank();
    }

    function test_cancelAllKillsEveryEarlierListing() public {
        TrozuMarket.Listing memory a = _fixed(PRICE_FIXED);
        TrozuMarket.Listing memory b = _fixed(PRICE_FIXED + 1e18);
        b.salt = 2;
        bytes memory sigA = _sign(sellerKey, a);
        bytes memory sigB = _sign(sellerKey, b);
        vm.prank(seller);
        market.cancelAll();
        _buyRevert(a, sigA, _invalid(TrozuMarket.State.NonceRevoked));
        _buyRevert(b, sigB, _invalid(TrozuMarket.State.NonceRevoked));

        // a listing signed after cancelAll works
        TrozuMarket.Listing memory c = _fixed(PRICE_FIXED);
        c.salt = 3;
        _buy(c, _sign(sellerKey, c));
        assertEq(nft.ownerOf(id), buyer);
    }

    function test_expiredListingNeverSettles() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        vm.warp(l.deadline + 1);
        _buyRevert(l, sig, _invalid(TrozuMarket.State.Expired));
    }

    function test_listingBeforeItsStartTimeDoesNotSettle() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        l.startTime = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(sellerKey, l);
        _buyRevert(l, sig, _invalid(TrozuMarket.State.NotStarted));
    }

    function test_staleEpochNeverSettlesEvenIfSellerOwnsItAgain() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        // seller moves the position away and gets it back
        vm.prank(seller);
        nft.transferFrom(seller, carol, id);
        vm.prank(carol);
        nft.transferFrom(carol, seller, id);
        _buyRevert(l, sig, _invalid(TrozuMarket.State.StaleEpoch));
        assertEq(nft.ownerOf(id), seller);
    }

    function test_listingByANonOwnerIsRefused() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        vm.prank(seller);
        nft.transferFrom(seller, carol, id);
        // epoch also moved, but ownership is checked first
        _buyRevert(l, sig, _invalid(TrozuMarket.State.NotOwner));
    }

    function test_listingNeedsTheMarketToBeApproved() public {
        vm.prank(seller);
        nft.setApprovalForAll(address(market), false);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        _buyRevert(l, sig, _invalid(TrozuMarket.State.NotApproved));
        // a single token approval is enough too
        vm.prank(seller);
        nft.approve(address(market), id);
        _buy(l, sig);
        assertEq(nft.ownerOf(id), buyer);
    }

    function test_signatureFromSomeoneElseIsRefused() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(buyerKey, l); // buyer signs a listing that names the seller
        _buyRevert(l, sig, _invalid(TrozuMarket.State.BadSignature));
    }

    function test_tamperedListingIsRefused() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        l.startPrice = 1e18;
        l.endPrice = 1e18;
        _buyRevert(l, sig, _invalid(TrozuMarket.State.BadSignature));
    }

    function test_listingForAnotherChainOrMarketIsRefused() public {
        TrozuMarket other = new TrozuMarket(address(nft), address(musd), address(troveManager), feeRecipient, FEE_BPS);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, other.hashListing(l));
        _buyRevert(l, abi.encodePacked(r, s, v), _invalid(TrozuMarket.State.BadSignature));
    }

    function test_closedTroveIsRefused() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        _fundMusd(seller, 400e18);
        vm.startPrank(seller);
        musd.approve(address(vault), type(uint256).max);
        vault.close();
        vm.stopPrank();
        _buyRevert(l, sig, _invalid(TrozuMarket.State.TroveInactive));
    }

    function test_redeemedTroveIsRefused() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        // the position is the lowest ratio, so a redemption of its exact net debt closes it
        address redeemer = makeAddr("redeemer");
        openBackgroundTrove(redeemer, 20_000e18, 1e18);
        uint256 amount = _debtOf(address(vault)) - 200e18;
        vm.prank(redeemer);
        troveManager.redeemCollateral(amount, address(0), address(0), address(0), 0, 0);
        assertEq(uint8(market.check(l, sig)), uint8(TrozuMarket.State.TroveInactive));
        _buyRevert(l, sig, _invalid(TrozuMarket.State.TroveInactive));
    }

    function test_zeroCollateralIsRefused() public {
        MockTroveManager mock = new MockTroveManager();
        TrozuMarket m2 = new TrozuMarket(address(nft), address(musd), address(mock), feeRecipient, FEE_BPS);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, m2.hashListing(l));
        vm.prank(seller);
        nft.setApprovalForAll(address(m2), true);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.expectRevert(_invalid(TrozuMarket.State.NoCollateral));
        vm.prank(buyer);
        m2.buy(l, abi.encodePacked(r, s, v), b, buyer, _noPermit());
    }

    function test_badParametersAreRefused() public {
        TrozuMarket.Listing memory l = _fixed(0);
        assertEq(uint8(market.check(l, "")), uint8(TrozuMarket.State.BadParams));
        TrozuMarket.Bounds memory b = _bounds(_fixed(1));
        vm.expectRevert(_invalid(TrozuMarket.State.BadParams));
        vm.prank(buyer);
        market.buy(l, "", b, buyer, _noPermit());

        l = _dutch(1000e18, 2000e18, 100); // rising price
        assertEq(uint8(market.check(l, "")), uint8(TrozuMarket.State.BadParams));
        l = _dutch(2000e18, 1000e18, 0); // no duration
        assertEq(uint8(market.check(l, "")), uint8(TrozuMarket.State.BadParams));
        l = _fixed(1000e18);
        l.startTime = uint64(block.timestamp + 10);
        l.deadline = l.startTime; // deadline not after start
        assertEq(uint8(market.check(l, "")), uint8(TrozuMarket.State.BadParams));
    }

    // ---- buyer bounds, read in the same transaction ----

    function test_sellerCannotStripCollateralAfterSigning() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.prank(seller);
        vault.withdrawCollateral(0.005e18, address(0), address(0));
        vm.expectRevert(); // CollateralBelowMin
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
        (uint256 coll,,,,,) = troveManager.getEntireDebtAndColl(address(vault));
        vm.expectRevert(abi.encodeWithSelector(TrozuMarket.CollateralBelowMin.selector, coll, b.minColl));
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
        assertEq(nft.ownerOf(id), seller);
    }

    function test_sellerCannotLoadMoreDebtAfterSigning() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.prank(seller);
        vault.borrow(100e18, address(0), address(0), 10e18);
        vm.expectRevert(abi.encodeWithSelector(TrozuMarket.DebtAboveMax.selector, _debtOf(address(vault)), b.maxDebt));
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
    }

    function test_rateRangeIsEnforced() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        b.minRateBps = 150; // the position locked 100
        b.maxRateBps = 300;
        vm.expectRevert(abi.encodeWithSelector(TrozuMarket.RateOutOfRange.selector, uint16(100), uint16(150), uint16(300)));
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
        b.minRateBps = 50;
        b.maxRateBps = 99;
        vm.expectRevert(abi.encodeWithSelector(TrozuMarket.RateOutOfRange.selector, uint16(100), uint16(50), uint16(99)));
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
        b.maxRateBps = 100; // inclusive
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
    }

    function test_expectedEpochMustMatch() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        b.expectedEpoch = l.epoch + 1;
        vm.expectRevert(abi.encodeWithSelector(TrozuMarket.EpochMismatch.selector, l.epoch + 1, l.epoch));
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
    }

    function test_maxPriceIsEnforced() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        b.maxPrice = PRICE_FIXED - 1;
        vm.expectRevert(abi.encodeWithSelector(TrozuMarket.PriceAboveMax.selector, PRICE_FIXED, PRICE_FIXED - 1));
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, _noPermit());
    }

    function test_failedPaymentMovesNothing() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        address poor = makeAddr("poor");
        vm.prank(poor);
        musd.approve(address(market), type(uint256).max);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.expectRevert();
        vm.prank(poor);
        market.buy(l, sig, b, poor, _noPermit());
        assertEq(nft.ownerOf(id), seller);
        assertEq(uint8(market.status(market.hashListing(l))), uint8(TrozuMarket.Status.Open), "not marked filled");
    }

    // ---- Dutch auction ----

    function test_dutchPriceFallsInAStraightLine() public {
        TrozuMarket.Listing memory l = _dutch(3000e18, 2000e18, 1000);
        uint256 t0 = block.timestamp;
        assertEq(market.priceAt(l, t0 - 5), 3000e18);
        assertEq(market.priceAt(l, t0), 3000e18);
        assertEq(market.priceAt(l, t0 + 250), 2750e18);
        assertEq(market.priceAt(l, t0 + 500), 2500e18);
        assertEq(market.priceAt(l, t0 + 1000), 2000e18);
        assertEq(market.priceAt(l, t0 + 99_999), 2000e18);
    }

    function test_dutchBuyPaysTheCurrentPrice() public {
        TrozuMarket.Listing memory l = _dutch(3000e18, 2000e18, 1000);
        bytes memory sig = _sign(sellerKey, l);
        vm.warp(block.timestamp + 500);
        (uint256 price, uint256 fee) = _buy(l, sig);
        assertEq(price, 2500e18);
        assertEq(fee, 6.25e18);
    }

    function test_dutchRoundsTheBuyersPriceUp() public {
        // 1000 wei drop over 3 seconds: after 1 second the exact price is 999.666..., rounded up to 1000... of 2000
        TrozuMarket.Listing memory l = _dutch(2000, 1000, 3);
        assertEq(market.priceAt(l, l.startTime + 1), 2000 - 333); // drop floors, price is 1667 (exact 1666.67)
        assertEq(market.priceAt(l, l.startTime + 2), 2000 - 666); // 1334 (exact 1333.33)
    }

    function test_feeIsRoundedUpAndSellerShareDown() public {
        TrozuMarket.Listing memory l = _fixed(1001); // 25 bps of 1001 is 2.5025, fee rounds up to 3
        assertEq(market.feeOn(1001), 3);
        assertEq(market.feeOn(1), 1);
        assertEq(market.feeOn(0), 0);
        assertEq(market.feeOn(4000), 10);
        l.salt = 9;
    }

    // ---- permit ----

    function test_buyWithPermitNeedsNoPriorApproval() public {
        vm.prank(buyer);
        musd.approve(address(market), 0);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        b.maxPrice = PRICE_FIXED + 10e18;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(buyerKey, buyer, address(market), b.maxPrice, deadline);
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, TrozuMarket.PermitData(deadline, v, r, s));
        assertEq(nft.ownerOf(id), buyer);
    }

    function test_frontRunPermitDoesNotBlockTheBuy() public {
        vm.prank(buyer);
        musd.approve(address(market), 0);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(buyerKey, buyer, address(market), b.maxPrice, deadline);
        // a griefer submits the permit first
        musd.permit(buyer, address(market), b.maxPrice, deadline, v, r, s);
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, TrozuMarket.PermitData(deadline, v, r, s));
        assertEq(nft.ownerOf(id), buyer);
    }

    function test_badPermitAndNoAllowanceReverts() public {
        vm.prank(buyer);
        musd.approve(address(market), 0);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.expectRevert();
        vm.prank(buyer);
        market.buy(l, sig, b, buyer, TrozuMarket.PermitData(block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2))));
        assertEq(nft.ownerOf(id), seller);
    }

    function _permit(uint256 key, address owner_, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner_,
                spender,
                value,
                musd.nonces(owner_),
                deadline
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---- ERC-1271 seller ----

    function test_contractWalletSellerWorksThroughErc1271() public {
        SmartWallet wallet = new SmartWallet(seller);
        // the wallet opens its own position and lists it
        vm.deal(address(wallet), 1 ether);
        vm.prank(seller);
        (uint256 wid, TrozuVault wv) = wallet.openOn(address(factory), 2000e18, 0.05e18);
        assertEq(nft.ownerOf(wid), address(wallet));
        vm.prank(seller);
        wallet.exec(address(nft), abi.encodeCall(nft.setApprovalForAll, (address(market), true)));

        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        l.seller = address(wallet);
        l.tokenId = wid;
        l.epoch = nft.transferEpoch(wid);
        l.salt = 77;
        // the wallet's owner key signs; the wallet vouches for it
        bytes memory sig = _sign(sellerKey, l);
        assertEq(uint8(market.check(l, sig)), uint8(TrozuMarket.State.Ok));

        uint256 before = musd.balanceOf(address(wallet));
        _buyFor(l, sig);
        assertEq(nft.ownerOf(wid), buyer);
        assertEq(musd.balanceOf(address(wallet)) - before, PRICE_FIXED - 6.25e18);
        wv; // silence
    }

    function test_contractWalletRejectsAForeignSignature() public {
        SmartWallet wallet = new SmartWallet(seller);
        vm.deal(address(wallet), 1 ether);
        vm.prank(seller);
        (uint256 wid,) = wallet.openOn(address(factory), 2000e18, 0.05e18);
        vm.prank(seller);
        wallet.exec(address(nft), abi.encodeCall(nft.setApprovalForAll, (address(market), true)));
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        l.seller = address(wallet);
        l.tokenId = wid;
        l.epoch = nft.transferEpoch(wid);
        bytes memory sig = _sign(buyerKey, l); // not the wallet owner
        assertEq(uint8(market.check(l, sig)), uint8(TrozuMarket.State.BadSignature));
    }

    function test_contractWalletCanCancelItself() public {
        SmartWallet wallet = new SmartWallet(seller);
        vm.deal(address(wallet), 1 ether);
        vm.prank(seller);
        (uint256 wid,) = wallet.openOn(address(factory), 2000e18, 0.05e18);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        l.seller = address(wallet);
        l.tokenId = wid;
        l.epoch = nft.transferEpoch(wid);
        vm.prank(seller);
        wallet.exec(address(market), abi.encodeCall(market.cancel, (l)));
        assertEq(uint8(market.status(market.hashListing(l))), uint8(TrozuMarket.Status.Cancelled));
    }

    function _buyFor(TrozuMarket.Listing memory l, bytes memory sig) internal {
        _buy(l, sig);
    }

    // ---- reentrancy ----

    function test_receiverHookCannotReenterTheMarket() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        ReenterOnReceive hook = new ReenterOnReceive(market, l, sig, _bounds(l));
        _fundMusd(address(hook), 10_000e18);
        vm.prank(address(hook));
        musd.approve(address(market), type(uint256).max);

        TrozuMarket.Bounds memory b = _bounds(l);
        vm.prank(address(hook));
        market.buy(l, sig, b, address(hook), _noPermit());

        assertTrue(hook.called(), "hook ran");
        assertFalse(hook.reenteredBuy(), "buy re-entry must fail");
        assertFalse(hook.reenteredAnnounce(), "announce of a filled listing must fail");
        assertEq(nft.ownerOf(id), address(hook));
        assertEq(musd.balanceOf(address(market)), 0);
    }

    function test_recipientThatCannotReceiveNftsMakesTheWholeBuyRevert() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        uint256 buyerBefore = musd.balanceOf(buyer);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.expectRevert();
        vm.prank(buyer);
        market.buy(l, sig, b, address(musd), _noPermit()); // MUSD has no onERC721Received
        assertEq(musd.balanceOf(buyer), buyerBefore, "payment rolled back");
        assertEq(nft.ownerOf(id), seller);
    }

    // ---- discovery ----

    function test_announceEmitsTheListingAndSignature() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        bytes memory sig = _sign(sellerKey, l);
        vm.expectEmit(true, true, true, true);
        emit TrozuMarket.ListingAnnounced(market.hashListing(l), seller, id, l, sig);
        vm.prank(carol); // anyone may relay
        market.announce(l, sig);
    }

    function test_announceRefusesAnythingThatWouldNotSettle() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        // no valid signature, so no spam
        bytes memory wrong = _sign(buyerKey, l);
        vm.expectRevert(_invalid(TrozuMarket.State.BadSignature));
        market.announce(l, wrong);
        // cancelled listings are not announced
        bytes memory sig = _sign(sellerKey, l);
        vm.prank(seller);
        market.cancel(l);
        vm.expectRevert(_invalid(TrozuMarket.State.Cancelled));
        market.announce(l, sig);
    }

    function test_cancelAndCancelAllEmitEvents() public {
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        vm.expectEmit(true, true, true, true);
        emit TrozuMarket.ListingCancelled(market.hashListing(l), seller, id);
        vm.prank(seller);
        market.cancel(l);
        vm.expectEmit(true, false, false, true);
        emit TrozuMarket.AllListingsCancelled(seller, 1);
        vm.prank(seller);
        market.cancelAll();
    }

    // ---- constructor ----

    function test_feeIsCappedInCode() public {
        assertEq(market.MAX_FEE_BPS(), 100);
        new TrozuMarket(address(nft), address(musd), address(troveManager), feeRecipient, 100); // allowed
        vm.expectRevert(TrozuMarket.FeeTooHigh.selector);
        new TrozuMarket(address(nft), address(musd), address(troveManager), feeRecipient, 101);
        vm.expectRevert(TrozuMarket.ZeroAddress.selector);
        new TrozuMarket(address(nft), address(musd), address(troveManager), address(0), 25);
    }

    function test_zeroFeeMarketWorks() public {
        TrozuMarket free = new TrozuMarket(address(nft), address(musd), address(troveManager), feeRecipient, 0);
        vm.prank(seller);
        nft.setApprovalForAll(address(free), true);
        vm.prank(buyer);
        musd.approve(address(free), type(uint256).max);
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, free.hashListing(l));
        uint256 sellerBefore = musd.balanceOf(seller);
        TrozuMarket.Bounds memory b = _bounds(l);
        vm.prank(buyer);
        free.buy(l, abi.encodePacked(r, s, v), b, buyer, _noPermit());
        assertEq(musd.balanceOf(seller) - sellerBefore, PRICE_FIXED);
        assertEq(musd.balanceOf(feeRecipient), 0);
    }

    // ---- the guardian does not outlive a sale ----

    function test_guardianPolicyDiesWithTheSale() public {
        vm.deal(seller, 1 ether);
        vm.startPrank(seller);
        vault.fundReserveBtc{value: 0.1e18}();
        vault.setPolicy(
            TrozuVault.Policy({
                epoch: 0,
                floorIcr: 1.3e18,
                targetIcr: 1.5e18,
                maxActionBtc: 0.05e18,
                maxActionMusd: 0,
                periodCapBtc: 0.1e18,
                periodCapMusd: 0,
                keeperTipBtc: 0,
                bufferFloorMusd: 0,
                period: 1 days,
                maxWalkSteps: 0,
                active: false
            })
        );
        vm.stopPrank();
        assertTrue(vault.policyLive());
        TrozuMarket.Listing memory l = _fixed(PRICE_FIXED);
        _buy(l, _sign(sellerKey, l));
        assertFalse(vault.policyLive(), "policy must not survive the sale");
        setPrice(40_000);
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.NothingToDo.selector, TrozuVault.Reason.PolicyStale));
        vm.prank(keeper);
        vault.execute(address(0), address(0));
    }

    // ---- fuzz ----

    function testFuzz_valueIsConserved(uint256 hi, uint256 spread, uint32 dur, uint32 elapsed) public {
        hi = bound(hi, 1000e18, 5000e18);
        spread = bound(spread, 0, hi - 1);
        dur = uint32(bound(dur, 1, 30 days));
        elapsed = uint32(bound(elapsed, 0, 2 * uint256(dur)));
        TrozuMarket.Listing memory l = spread == 0 ? _fixed(hi) : _dutch(hi, hi - spread, dur);
        l.deadline = uint64(block.timestamp + 200 days); // long enough that only the price curve is under test
        bytes memory sig = _sign(sellerKey, l);
        vm.warp(block.timestamp + elapsed);

        uint256 b0 = musd.balanceOf(buyer);
        uint256 s0 = musd.balanceOf(seller);
        uint256 f0 = musd.balanceOf(feeRecipient);
        (uint256 price, uint256 fee) = _buy(l, sig);

        assertEq(b0 - musd.balanceOf(buyer), price);
        assertEq(musd.balanceOf(seller) - s0, price - fee);
        assertEq(musd.balanceOf(feeRecipient) - f0, fee);
        assertEq((musd.balanceOf(seller) - s0) + (musd.balanceOf(feeRecipient) - f0), price);
        assertEq(musd.balanceOf(address(market)), 0);
        assertEq(nft.ownerOf(id), buyer);
        assertLe(fee, price * FEE_BPS / 10_000 + 1);
        assertGe(fee * 10_000, price * FEE_BPS, "fee rounds up, so the seller's share rounds down");
        assertLe(price, l.startPrice);
        assertGe(price, l.endPrice);
    }

    function testFuzz_dutchPriceNeverUndercutsTheExactLine(uint256 hi, uint256 lo, uint32 dur, uint32 elapsed) public {
        hi = bound(hi, 2, 1e30);
        lo = bound(lo, 1, hi);
        dur = uint32(bound(dur, 1, 365 days));
        elapsed = uint32(bound(elapsed, 0, dur));
        TrozuMarket.Listing memory l = _fixed(hi);
        l.endPrice = lo;
        l.startTime = 1000;
        l.endTime = 1000 + dur;
        uint256 p = market.priceAt(l, 1000 + elapsed);
        // exact price is hi - (hi-lo)*elapsed/dur. The contract's price is never below it.
        assertGe(p * dur, hi * dur - (hi - lo) * elapsed, "buyer never pays less than the line");
        assertLe(p, hi);
        assertGe(p, lo);
        // and it is non-increasing in time
        if (elapsed < dur) assertGe(p, market.priceAt(l, 1000 + elapsed + 1));
    }
}

/// Mock for the zero-collateral branch: an "active" trove with nothing in it.
contract MockTroveManager {
    function getTroveStatus(address) external pure returns (ITroveManager.Status) {
        return ITroveManager.Status.active;
    }

    function getEntireDebtAndColl(address) external pure returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (0, 0, 0, 0, 0, 0);
    }

    function getTroveInterestRate(address) external pure returns (uint16) {
        return 100;
    }
}

/// Minimal ERC-1271 wallet: valid when the owner's key signed.
contract SmartWallet is IERC721Receiver {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    receive() external payable {}

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address who, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return (err == ECDSA.RecoverError.NoError && who == owner) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function exec(address to, bytes calldata data) external {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory ret) = to.call(data);
        require(ok, string(ret));
    }

    function openOn(address factory, uint256 debt, uint256 coll) external returns (uint256 id, TrozuVault vault) {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory ret) = factory.call{value: coll}(
            abi.encodeWithSignature("openPosition(uint256,address,address,uint256)", debt, address(0), address(0), debt / 100)
        );
        require(ok, "open");
        address v;
        (id, v) = abi.decode(ret, (uint256, address));
        vault = TrozuVault(payable(v));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// Tries to re-enter the market while it is being handed the position.
contract ReenterOnReceive is IERC721Receiver {
    TrozuMarket internal market;
    TrozuMarket.Listing internal l;
    bytes internal sig;
    TrozuMarket.Bounds internal b;
    bool public called;
    bool public reenteredBuy;
    bool public reenteredAnnounce;

    constructor(TrozuMarket m, TrozuMarket.Listing memory listing, bytes memory s, TrozuMarket.Bounds memory bounds) {
        market = m;
        l = listing;
        sig = s;
        b = bounds;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        called = true;
        try market.buy(l, sig, b, address(this), TrozuMarket.PermitData(0, 0, 0, 0)) {
            reenteredBuy = true;
        } catch {}
        try market.announce(l, sig) {
            reenteredAnnounce = true;
        } catch {}
        return IERC721Receiver.onERC721Received.selector;
    }
}
