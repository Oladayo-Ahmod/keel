// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {TrozuFactory} from "../../src/v2/TrozuFactory.sol";
import {TrozuNFT} from "../../src/v2/TrozuNFT.sol";
import {TrozuVault} from "../../src/v2/TrozuVault.sol";
import {TrozuMarket} from "../../src/v2/TrozuMarket.sol";
import {PositionLens} from "../../src/PositionLens.sol";
import {MezoCore} from "../../src/MezoCore.sol";
import {IBorrowerOperations, ITroveManager, IMUSD} from "../../src/interfaces/mezo/IMezo.sol";
import {MainnetCore} from "../../script/MainnetCore.sol";

interface IMinNetDebtFork {
    function minNetDebt() external view returns (uint256);
}

interface ITroveCount {
    function getTroveOwnersCount() external view returns (uint256);
    function getNominalICR(address) external view returns (uint256);
}

/// The same flows as the local tests, against the live Mezo mainnet contracts and
/// state, forked at a pinned block. Real MUSD, real BorrowerOperations, real
/// TroveManager and sorted list. The only fake is the oracle: Mezo's price feed
/// reads a chain precompile that a fork cannot run, so `fetchPrice` is mocked. Nothing
/// is sent anywhere: a fork lives in memory.
///
/// Run: forge test --match-path "test/fork/*" --fork-retries 10 --fork-retry-backoff 2000
/// The first run downloads state over a flaky public RPC; Foundry caches a pinned
/// block under ~/.foundry/cache/rpc, so later runs are fast and repeatable.
contract MainnetForkTest is Test {
    uint256 internal constant FORK_BLOCK = 13_040_764; // see docs/MARKET_DATA.md, the same pin
    uint256 internal constant BTC_PRICE = 80_000;

    MezoCore internal core;
    TrozuFactory internal factory;
    TrozuNFT internal nft;
    TrozuMarket internal market;
    PositionLens internal lens;
    IMUSD internal musd;
    ITroveCount internal tm;

    uint256 internal sellerKey = 0xB0B;
    address internal seller;
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        vm.createSelectFork("mezo_mainnet", FORK_BLOCK);
        core = MainnetCore.get();
        musd = IMUSD(core.musd);
        tm = ITroveCount(core.troveManager);
        seller = vm.addr(sellerKey);

        _price(BTC_PRICE);
        factory = new TrozuFactory(core, 0);
        nft = factory.nft();
        lens = factory.lens();
        market = new TrozuMarket(address(nft), core.musd, core.troveManager, feeRecipient, 25);
    }

    // ---- helpers ----

    function _price(uint256 usd) internal {
        vm.mockCall(core.priceFeed, abi.encodeWithSignature("fetchPrice()"), abi.encode(usd * 1e18));
    }

    function _debtFor(uint256 extra) internal view returns (uint256) {
        return IMinNetDebtFork(core.borrowerOperations).minNetDebt() + extra;
    }

    // collateral for a target ratio at the mocked price, on the composite debt (fee 0.1% and the 200 gas reserve)
    function _collFor(uint256 debt, uint256 icr1e18) internal pure returns (uint256) {
        uint256 composite = debt + debt / 100 + 200e18; // generous fee allowance, so the real ratio lands a little above
        return composite * icr1e18 / (BTC_PRICE * 1e18);
    }

    function _open(address who, uint256 debt, uint256 icr) internal returns (uint256 id, TrozuVault vault) {
        uint256 coll = _collFor(debt, icr);
        vm.deal(who, who.balance + coll + 1 ether);
        vm.prank(who);
        (uint256 tokenId, address v) = factory.openPosition{value: coll}(debt, address(0), address(0), debt / 20);
        return (tokenId, TrozuVault(payable(v)));
    }

    function _sign(uint256 key, TrozuMarket.Listing memory l) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, market.hashListing(l));
        return abi.encodePacked(r, s, v);
    }

    function _icr(TrozuVault v) internal view returns (uint256) {
        (uint256 coll, uint256 p, uint256 i,,,) = ITroveManager(core.troveManager).getEntireDebtAndColl(address(v));
        return coll * BTC_PRICE * 1e18 / (p + i);
    }

    // ---- the fork is what we think it is ----

    function test_forkIsTheRealMainnetAtThePinnedBlock() public view {
        assertEq(block.chainid, 31612);
        assertEq(block.number, FORK_BLOCK);
        assertEq(tm.getTroveOwnersCount(), 3, "three troves on mainnet at the pin");
        assertGt(musd.totalSupply(), 0);
        assertEq(IMinNetDebtFork(core.borrowerOperations).minNetDebt(), 1800e18);
    }

    // ---- open, transfer, list, buy ----

    function test_openTransferListBuyAgainstLiveMusd() public {
        uint256 troves0 = tm.getTroveOwnersCount();
        (uint256 id, TrozuVault vault) = _open(alice, _debtFor(200e18), 1.5e18);
        assertEq(tm.getTroveOwnersCount(), troves0 + 1, "a real mainnet trove was opened by the vault");
        assertEq(uint8(ITroveManager(core.troveManager).getTroveStatus(address(vault))), uint8(ITroveManager.Status.active));
        assertEq(nft.ownerOf(id), alice);
        assertGt(musd.balanceOf(alice), 0);

        // alice hands the position to the seller
        vm.prank(alice);
        nft.transferFrom(alice, seller, id);
        assertEq(nft.ownerOf(id), seller);

        // seller lists it at a fixed price
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        TrozuMarket.Listing memory l = TrozuMarket.Listing({
            seller: seller,
            tokenId: id,
            epoch: nft.transferEpoch(id),
            startPrice: 1500e18,
            endPrice: 1500e18,
            startTime: 0,
            endTime: 0,
            deadline: uint64(block.timestamp + 1 days),
            nonce: 0,
            salt: 1
        });
        bytes memory sig = _sign(sellerKey, l);
        assertEq(uint8(market.check(l, sig)), uint8(TrozuMarket.State.Ok));

        // carol gets MUSD the honest way: her own trove on mainnet
        vm.deal(carol, 10 ether);
        vm.prank(carol);
        IBorrowerOperations(core.borrowerOperations).openTrove{value: 1 ether}(5000e18, address(0), address(0));
        assertGe(musd.balanceOf(carol), 5000e18);
        vm.prank(carol);
        musd.approve(address(market), type(uint256).max);

        (uint256 coll, uint256 p, uint256 interest,,,) = ITroveManager(core.troveManager).getEntireDebtAndColl(address(vault));
        TrozuMarket.Bounds memory b = TrozuMarket.Bounds({
            expectedEpoch: l.epoch,
            minColl: coll,
            maxDebt: p + interest + 1e18,
            minRateBps: 0,
            maxRateBps: 10_000,
            maxPrice: 1500e18
        });
        uint256 carolBefore = musd.balanceOf(carol);
        uint256 sellerBefore = musd.balanceOf(seller);
        vm.prank(carol);
        (uint256 price, uint256 fee) = market.buy(l, sig, b, carol, TrozuMarket.PermitData(0, 0, 0, 0));

        assertEq(price, 1500e18);
        assertEq(fee, 3.75e18);
        assertEq(carolBefore - musd.balanceOf(carol), 1500e18);
        assertEq(musd.balanceOf(seller) - sellerBefore, 1500e18 - 3.75e18);
        assertEq(musd.balanceOf(feeRecipient), 3.75e18, "the fee reached the recipient in real MUSD");
        assertEq(nft.ownerOf(id), carol);
        assertEq(musd.balanceOf(address(market)), 0);
        // the position the buyer paid for is the position that is there
        PositionLens.Info memory info = lens.positionInfo(id);
        assertEq(info.holder, carol);
        assertEq(info.coll, coll);
        assertEq(info.lockedRateBps, 100, "locked at the live global rate");
    }

    function test_aStaleListingCannotBeFilledAgainstLiveState() public {
        (uint256 id, TrozuVault vault) = _open(alice, _debtFor(200e18), 1.5e18);
        vm.prank(alice);
        nft.transferFrom(alice, seller, id);
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        TrozuMarket.Listing memory l = TrozuMarket.Listing({
            seller: seller, tokenId: id, epoch: nft.transferEpoch(id), startPrice: 1500e18, endPrice: 1500e18,
            startTime: 0, endTime: 0, deadline: uint64(block.timestamp + 1 days), nonce: 0, salt: 1
        });
        bytes memory sig = _sign(sellerKey, l);

        // the seller strips collateral after signing; the buyer's bound catches it against real Mezo state
        (uint256 coll, uint256 p, uint256 interest,,,) = ITroveManager(core.troveManager).getEntireDebtAndColl(address(vault));
        TrozuMarket.Bounds memory b = TrozuMarket.Bounds({
            expectedEpoch: l.epoch, minColl: coll, maxDebt: p + interest + 1e18,
            minRateBps: 0, maxRateBps: 10_000, maxPrice: 1500e18
        });
        vm.prank(seller);
        vault.withdrawCollateral(coll / 10, address(0), address(0));

        vm.deal(carol, 10 ether);
        vm.prank(carol);
        IBorrowerOperations(core.borrowerOperations).openTrove{value: 1 ether}(5000e18, address(0), address(0));
        vm.prank(carol);
        musd.approve(address(market), type(uint256).max);
        vm.expectRevert();
        vm.prank(carol);
        market.buy(l, sig, b, carol, TrozuMarket.PermitData(0, 0, 0, 0));
        assertEq(nft.ownerOf(id), seller);
    }

    // ---- guardian ----

    function test_guardianTopUpAgainstLiveMainnet() public {
        (uint256 id, TrozuVault vault) = _open(alice, _debtFor(200e18), 1.5e18);
        vm.deal(alice, 5 ether);
        vm.startPrank(alice);
        vault.fundReserveBtc{value: 0.1 ether}();
        vault.setPolicy(
            TrozuVault.Policy({
                epoch: 0,
                floorIcr: 1.3e18,
                targetIcr: 1.6e18,
                maxActionBtc: 0.05e18,
                maxActionMusd: 0,
                periodCapBtc: 0.1e18,
                periodCapMusd: 0,
                keeperTipBtc: 1e13,
                bufferFloorMusd: 0,
                period: 1 days,
                maxWalkSteps: 0,
                active: false
            })
        );
        vm.stopPrank();

        // healthy at 80k
        assertEq(uint8(vault.preview().reason), uint8(TrozuVault.Reason.Healthy));

        // BTC falls to 60k and the position goes under its floor
        _price(60_000);
        assertEq(uint8(vault.preview().kind), uint8(TrozuVault.Kind.TopUpBtc));
        uint256 keeperBefore = keeper.balance;
        (uint256 collBefore,,,,,) = ITroveManager(core.troveManager).getEntireDebtAndColl(address(vault));
        vm.prank(keeper);
        (, uint256 amount, uint256 tip) = vault.execute(address(0), address(0));

        (uint256 c1, uint256 p1, uint256 i1,,,) = ITroveManager(core.troveManager).getEntireDebtAndColl(address(vault));
        assertEq(c1, collBefore + amount, "real mainnet collateral grew by the amount");
        assertEq(keeper.balance - keeperBefore, tip);
        assertGe(c1 * 60_000e18 / (p1 + i1), 1.6e18, "ratio restored to the target on live state");
        assertEq(address(vault).balance, vault.reserveBtc());
        id;
    }

    function _defensePolicy(uint16 walk) internal pure returns (TrozuVault.Policy memory) {
        return TrozuVault.Policy({
            epoch: 0,
            floorIcr: 1.3e18,
            targetIcr: 3e18,
            maxActionBtc: 0.05e18,
            maxActionMusd: 0,
            periodCapBtc: 0.2e18,
            periodCapMusd: 0,
            keeperTipBtc: 0,
            bufferFloorMusd: 500_000e18, // far above the real buffer
            period: 1 days,
            maxWalkSteps: walk,
            active: false
        });
    }

    function test_redemptionDefenseAgainstTheLiveSortedList() public {
        // the position lands in the live list just above two real troves that are redeemable at 80k
        (uint256 id, TrozuVault vault) = _open(alice, _debtFor(200e18), 1.5e18);

        PositionLens.Buffer memory buf = lens.redemptionBuffer(id, 50);
        assertTrue(buf.complete, "a complete walk of the live list");
        assertGt(buf.buffer, 50_000e18, "tens of thousands of MUSD of real debt sit ahead");
        assertEq(buf.eligibleAhead, 2);

        vm.deal(alice, 5 ether);
        vm.startPrank(alice);
        vault.fundReserveBtc{value: 0.5 ether}();

        // a walk too short to finish is Unknown, and Unknown never acts
        vault.setPolicy(_defensePolicy(1));
        assertEq(uint8(vault.preview().reason), uint8(TrozuVault.Reason.BufferUnknown));
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.NothingToDo.selector, TrozuVault.Reason.BufferUnknown));
        vm.prank(keeper);
        vault.execute(address(0), address(0));

        // with room to finish, the complete walk proves the buffer is low and the top-up goes through
        vm.prank(alice);
        vault.setPolicy(_defensePolicy(10));
        uint256 nicr0 = tm.getNominalICR(address(vault));
        assertEq(uint8(vault.preview().kind), uint8(TrozuVault.Kind.DefendBtc));
        vm.prank(keeper);
        (, uint256 amount,) = vault.execute(address(0), address(0));
        assertGt(amount, 0);
        assertGt(tm.getNominalICR(address(vault)), nicr0, "NICR rose on the live list");
    }

    function test_policyDiesOnTransferOnLiveMainnetToo() public {
        (uint256 id, TrozuVault vault) = _open(alice, _debtFor(200e18), 1.5e18);
        vm.deal(alice, 5 ether);
        vm.startPrank(alice);
        vault.fundReserveBtc{value: 0.1 ether}();
        vault.setPolicy(
            TrozuVault.Policy({
                epoch: 0, floorIcr: 1.3e18, targetIcr: 1.6e18, maxActionBtc: 0.05e18, maxActionMusd: 0,
                periodCapBtc: 0.1e18, periodCapMusd: 0, keeperTipBtc: 0, bufferFloorMusd: 0,
                period: 1 days, maxWalkSteps: 0, active: false
            })
        );
        nft.transferFrom(alice, carol, id);
        vm.stopPrank();
        _price(60_000);
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.NothingToDo.selector, TrozuVault.Reason.PolicyStale));
        vm.prank(keeper);
        vault.execute(address(0), address(0));
    }

    function test_closeReturnsRealCollateralOnLiveMainnet() public {
        (uint256 id, TrozuVault vault) = _open(alice, _debtFor(200e18), 1.5e18);
        // alice needs the debt back in MUSD, she holds what she borrowed; top up the 200 gas reserve + fee from a trove of her own
        vm.deal(carol, 10 ether);
        vm.prank(carol);
        IBorrowerOperations(core.borrowerOperations).openTrove{value: 1 ether}(5000e18, address(0), address(0));
        vm.prank(carol);
        musd.transfer(alice, 500e18);
        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);
        uint256 btc0 = alice.balance;
        vault.close();
        vm.stopPrank();
        assertGt(alice.balance - btc0, 0, "collateral came back to the holder");
        assertEq(uint8(ITroveManager(core.troveManager).getTroveStatus(address(vault))), uint8(ITroveManager.Status.closedByOwner));
        id;
    }
}
