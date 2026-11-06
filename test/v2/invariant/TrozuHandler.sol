// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {MUSD} from "musd/token/MUSD.sol";
import {BorrowerOperations} from "musd/BorrowerOperations.sol";
import {TroveManager} from "musd/TroveManager.sol";
import {CollSurplusPool} from "musd/CollSurplusPool.sol";
import {InterestRateManager} from "musd/InterestRateManager.sol";
import {MockAggregator} from "musd/tests/MockAggregator.sol";

import {TrozuFactory} from "../../../src/v2/TrozuFactory.sol";
import {TrozuNFT} from "../../../src/v2/TrozuNFT.sol";
import {TrozuVault} from "../../../src/v2/TrozuVault.sol";
import {TrozuMarket} from "../../../src/v2/TrozuMarket.sol";
import {ITroveManager} from "../../../src/interfaces/mezo/IMezo.sol";

struct HandlerDeps {
    TrozuFactory factory;
    MUSD musd;
    BorrowerOperations bo;
    TroveManager tm;
    CollSurplusPool surplus;
    InterestRateManager irm;
    MockAggregator aggregator;
    address council;
    address aggregatorOwner;
    TrozuMarket market;
    address feeRecipient;
}

/// Drives Trozu positions through everything that can happen to them: holder
/// actions, transfers, strangers, redemption, liquidation, price, rate and time.
///
/// It keeps a ledger L = collateral + claimable surplus for every vault and
/// checks the movement of L after each step:
///   holder action on vault i:  L[i] moves by exactly (btc in - btc out), others unchanged
///   redemption:                no L increases
///   liquidation:               the liquidated L may fall, every other L may only rise
///   price, rate, time:         every L unchanged
/// Violations are counted and asserted by the invariant suite.
contract TrozuHandler is Test {
    HandlerDeps internal d;
    TrozuNFT internal nft;

    address[] internal actors;
    uint256[] internal actorKeys;
    address internal redeemer;
    address internal keeperAddr;

    TrozuVault[] internal vaults;
    uint256[] internal ids;
    address[] internal holders; // expected holder per vault
    mapping(uint256 => address[]) internal history; // every earlier holder, by vault index

    uint256 internal price = 60_000;

    // ghost accounting for the rolling outflow invariant
    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public ghostGains;

    uint256 public ledgerViolations;
    uint256 public externalViolations;
    uint256 public approvalViolations;
    uint256 public unauthorizedSuccess;
    uint256 public holderMismatch;

    // v2
    uint256 public guardianViolations;
    uint256 public guardianActions;
    uint256 public marketViolations;
    uint256 public marketSales;
    uint256 public policyLiveMismatch;

    // what the handler believes about each policy, independent of the contract
    mapping(uint256 => bool) internal policySet;
    mapping(uint256 => uint256) internal policyEpoch;

    struct Rec {
        TrozuMarket.Listing l;
        bytes sig;
        bool cancelled;
        bool sold;
    }

    Rec[] internal recs;
    mapping(address => uint256) internal nonceOf; // the handler's own count of cancelAll calls

    mapping(bytes32 => uint256) public calls;

    constructor(HandlerDeps memory deps) {
        d = deps;
        nft = deps.factory.nft();
        for (uint256 k; k < 4; k++) {
            actorKeys.push(0xA11CE + k);
            actors.push(vm.addr(0xA11CE + k));
        }
        redeemer = makeAddr("redeemer");
        keeperAddr = makeAddr("keeper");
        for (uint256 i; i < actors.length; i++) {
            vm.deal(actors[i], 1000 ether);
        }
    }

    receive() external payable {}

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function vaultAt(uint256 i) external view returns (TrozuVault) {
        return vaults[i];
    }

    function idAt(uint256 i) external view returns (uint256) {
        return ids[i];
    }

    function expectedHolder(uint256 i) external view returns (address) {
        return holders[i];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function init() external {
        for (uint256 i; i < 3; i++) {
            _open(actors[i], 2000e18 + i * 300e18, 20_000 + i * 3000);
        }
        // the redeemer holds a lot of MUSD and has its own deep trove
        vm.deal(redeemer, 100 ether);
        vm.prank(redeemer);
        d.bo.openTrove{value: 50 ether}(100_000e18, address(0), address(0));
    }

    function openNew(uint256 actorSeed, uint256 debtSeed, uint256 icrSeed) external {
        calls["openNew"]++;
        if (vaults.length >= 6) return;
        _open(actors[actorSeed % actors.length], bound(debtSeed, 1800e18, 8000e18), bound(icrSeed, 17_000, 35_000));
    }

    function addCollateral(uint256 pSeed, uint256 amount) external {
        calls["addCollateral"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 0.001e18, 1e18);
        uint256[] memory before = _snap();
        vm.deal(holder, holder.balance + amount);
        vm.prank(holder);
        try vaults[i].addCollateral{value: amount}(address(0), address(0)) {
            _holderOp(i, amount, 0, before);
        } catch {}
    }

    function withdrawCollateral(uint256 pSeed, uint256 amount) external {
        calls["withdrawCollateral"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 1, _coll(i));
        uint256[] memory before = _snap();
        uint256 btc = holder.balance;
        vm.prank(holder);
        try vaults[i].withdrawCollateral(amount, address(0), address(0)) {
            _holderOp(i, 0, holder.balance - btc, before);
        } catch {}
    }

    function borrow(uint256 pSeed, uint256 amount) external {
        calls["borrow"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 1e18, 2000e18);
        uint256[] memory before = _snap();
        vm.prank(holder);
        try vaults[i].borrow(amount, address(0), address(0), amount / 100 + 1) {
            _holderOp(i, 0, 0, before);
        } catch {}
    }

    function repay(uint256 pSeed, uint256 amount) external {
        calls["repay"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 1e18, 1500e18);
        _fund(holder, amount, address(vaults[i]));
        uint256[] memory before = _snap();
        vm.prank(holder);
        try vaults[i].repay(amount, address(0), address(0)) {
            _holderOp(i, 0, 0, before);
        } catch {}
    }

    function adjust(uint256 pSeed, uint256 collIn, uint256 debtChange, bool increase) external {
        calls["adjust"]++;
        (uint256 i, address holder) = _pick(pSeed);
        collIn = bound(collIn, 0, 0.5e18);
        debtChange = bound(debtChange, 1e18, 1000e18);
        if (!increase) _fund(holder, debtChange, address(vaults[i]));
        uint256[] memory before = _snap();
        vm.deal(holder, holder.balance + collIn);
        uint256 btc = holder.balance - collIn;
        vm.prank(holder);
        try vaults[i].adjust{value: collIn}(0, debtChange, increase, address(0), address(0), debtChange / 100 + 1) {
            _holderOp(i, collIn, holder.balance - btc, before);
        } catch {}
    }

    function refinance(uint256 pSeed, uint16 minDrop) external {
        calls["refinance"]++;
        (uint256 i, address holder) = _pick(pSeed);
        uint256[] memory before = _snap();
        vm.prank(holder);
        try vaults[i].refinance(address(0), address(0), 20e18, uint16(bound(minDrop, 0, 100))) {
            _holderOp(i, 0, 0, before);
        } catch {}
    }

    function close(uint256 pSeed) external {
        calls["close"]++;
        (uint256 i, address holder) = _pick(pSeed);
        (, uint256 p, uint256 interest,,,) = d.tm.getEntireDebtAndColl(address(vaults[i]));
        if (p + interest < 200e18) return;
        _fund(holder, p + interest - 200e18, address(vaults[i]));
        uint256[] memory before = _snap();
        uint256 btc = holder.balance;
        vm.prank(holder);
        try vaults[i].close() {
            _holderOp(i, 0, holder.balance - btc, before);
        } catch {}
    }

    function reopen(uint256 pSeed, uint256 debtSeed) external {
        calls["reopen"]++;
        (uint256 i, address holder) = _pick(pSeed);
        if (uint8(d.tm.getTroveStatus(address(vaults[i]))) == uint8(ITroveManager.Status.active)) return;
        uint256 debt = bound(debtSeed, 1800e18, 4000e18);
        uint256 coll = _collFor(debt, 25_000);
        uint256[] memory before = _snap();
        vm.deal(holder, holder.balance + coll);
        vm.prank(holder);
        try vaults[i].open{value: coll}(debt, address(0), address(0), debt / 100) {
            _holderOp(i, coll, 0, before);
        } catch {}
    }

    function claimSurplus(uint256 pSeed) external {
        calls["claimSurplus"]++;
        (uint256 i, address holder) = _pick(pSeed);
        uint256[] memory before = _snap();
        uint256 btc = holder.balance;
        vm.prank(holder);
        try vaults[i].claimSurplus() {
            _holderOp(i, 0, holder.balance - btc, before);
        } catch {}
    }

    function approveOperator(uint256 pSeed, uint256 opSeed, bool forAll) external {
        calls["approveOperator"]++;
        (uint256 i, address holder) = _pick(pSeed);
        address op = actors[opSeed % actors.length];
        if (op == holder) return;
        vm.prank(holder);
        if (forAll) nft.setApprovalForAll(op, true);
        else nft.approve(op, ids[i]);
    }

    function transfer(uint256 pSeed, uint256 toSeed) external {
        calls["transfer"]++;
        (uint256 i, address holder) = _pick(pSeed);
        address to = actors[toSeed % actors.length];
        if (to == holder) return;
        vm.prank(holder);
        nft.transferFrom(holder, to, ids[i]);
        history[i].push(holder);
        holders[i] = to;
        // a transfer clears the single-token approval
        if (nft.getApproved(ids[i]) != address(0)) approvalViolations++;
    }

    /// Someone who is not the holder tries a holder function. Previous holders and
    /// operators are the interesting callers, so they are picked often.
    function strangerCalls(uint256 pSeed, uint256 whoSeed, uint256 fnSeed) external {
        calls["strangerCalls"]++;
        (uint256 i, address holder) = _pick(pSeed);

        address who;
        uint256 n = history[i].length;
        if (n > 0 && whoSeed % 2 == 0) who = history[i][(whoSeed / 2) % n];
        else who = actors[whoSeed % actors.length];
        if (who == holder) who = makeAddr("stranger");

        TrozuVault v = vaults[i];
        bytes memory data;
        uint256 k = fnSeed % 12;
        if (k == 0) data = abi.encodeCall(v.withdrawCollateral, (1, address(0), address(0)));
        else if (k == 1) data = abi.encodeCall(v.borrow, (10e18, address(0), address(0), 1e18));
        else if (k == 2) data = abi.encodeCall(v.close, ());
        else if (k == 3) data = abi.encodeCall(v.sweep, (address(0)));
        else if (k == 4) data = abi.encodeCall(v.claimSurplus, ());
        else if (k == 5) data = abi.encodeCall(v.repay, (1e18, address(0), address(0)));
        else if (k == 6) data = abi.encodeCall(v.refinance, (address(0), address(0), 1e18, 1));
        else if (k == 7) data = abi.encodeCall(v.open, (2000e18, address(0), address(0), 20e18));
        else if (k == 8) data = abi.encodeCall(v.setPolicy, (_policy(1.3e18, 1.5e18, 0.05e18, 0)));
        else if (k == 9) data = abi.encodeCall(v.clearPolicy, ());
        else if (k == 10) data = abi.encodeCall(v.fundReserveBtc, ());
        else data = abi.encodeCall(v.withdrawReserveBtc, (0));

        vm.deal(who, who.balance + 1e18);
        vm.prank(who);
        (bool ok,) = address(v).call(data);
        if (ok) unauthorizedSuccess++;
    }

    function redeem(uint256 vSeed, uint256 amount, bool exact) external {
        calls["redeem"]++;
        if (vaults.length == 0) return;
        if (exact) {
            (, uint256 p, uint256 interest,,,) = d.tm.getEntireDebtAndColl(address(vaults[vSeed % vaults.length]));
            amount = p + interest > 200e18 ? p + interest - 200e18 : 1800e18;
        } else {
            amount = bound(amount, 1800e18, 6000e18);
        }
        _mintTo(redeemer, amount);
        uint256[] memory before = _snap();
        vm.prank(redeemer);
        try d.tm.redeemCollateral(amount, address(0), address(0), address(0), 0, 0) {
            uint256[] memory afterL = _snap();
            for (uint256 j; j < before.length; j++) {
                if (afterL[j] > before[j]) externalViolations++;
            }
        } catch {}
    }

    function movePrice(uint256 seed) external {
        calls["movePrice"]++;
        uint256[] memory before = _snap();
        price = bound(seed, 30_000, 90_000);
        vm.prank(d.aggregatorOwner); // the mock oracle is owned by the test contract
        d.aggregator.setPrice(price * 1e8);
        _expectUnchanged(before);
    }

    function liquidateAll() external {
        calls["liquidateAll"]++;
        for (uint256 i; i < vaults.length; i++) {
            address v = address(vaults[i]);
            if (uint8(d.tm.getTroveStatus(v)) != uint8(ITroveManager.Status.active)) continue;
            if (d.tm.getCurrentICR(v, price * 1e18) >= 1.1e18) continue;

            uint256[] memory before = _snap();
            try d.tm.liquidate(v) {
                uint256[] memory afterL = _snap();
                for (uint256 j; j < before.length; j++) {
                    if (j == i) {
                        if (afterL[j] > before[j]) externalViolations++;
                    } else if (afterL[j] < before[j]) {
                        externalViolations++;
                    } else {
                        ghostGains += afterL[j] - before[j];
                    }
                }
            } catch {}
        }
    }

    function setRate(uint256 seed) external {
        calls["setRate"]++;
        uint256[] memory before = _snap();
        uint16 rate = uint16(bound(seed, 0, 500));
        vm.startPrank(d.council);
        try d.irm.proposeInterestRate(rate) {
            vm.warp(block.timestamp + 7 days);
            try d.irm.approveInterestRate() {} catch {}
        } catch {}
        vm.stopPrank();
        _expectUnchanged(before);
    }

    function warp(uint256 seed) external {
        calls["warp"]++;
        uint256[] memory before = _snap();
        vm.warp(block.timestamp + bound(seed, 1 hours, 30 days));
        _expectUnchanged(before);
    }

    function checkHolders() external {
        for (uint256 i; i < vaults.length; i++) {
            if (nft.ownerOf(ids[i]) != holders[i]) holderMismatch++;
            bool live = policySet[i] && policyEpoch[i] == nft.transferEpoch(ids[i]);
            if (vaults[i].policyLive() != live) policyLiveMismatch++;
        }
    }


    // ------------------------------------------------------------------
    // v2: reserve, guardian, market
    // ------------------------------------------------------------------

    function _policy(uint256 floor, uint256 target, uint256 maxBtc, uint256 bufferFloor)
        internal
        pure
        returns (TrozuVault.Policy memory)
    {
        return TrozuVault.Policy({
            epoch: 0,
            floorIcr: floor,
            targetIcr: target,
            maxActionBtc: maxBtc,
            maxActionMusd: 300e18,
            periodCapBtc: maxBtc * 3,
            periodCapMusd: 900e18,
            keeperTipBtc: 1e13,
            bufferFloorMusd: bufferFloor,
            period: 1 days,
            maxWalkSteps: bufferFloor > 0 ? 10 : 0,
            active: false
        });
    }

    function fundReserveBtc(uint256 pSeed, uint256 amount) external {
        calls["fundReserveBtc"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 0.001e18, 0.3e18);
        uint256[] memory before = _snap();
        vm.deal(holder, holder.balance + amount);
        vm.prank(holder);
        try vaults[i].fundReserveBtc{value: amount}() {
            _holderOp(i, amount, 0, before);
        } catch {}
    }

    function withdrawReserveBtc(uint256 pSeed, uint256 amount) external {
        calls["withdrawReserveBtc"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 0, vaults[i].reserveBtc());
        uint256[] memory before = _snap();
        uint256 btc = holder.balance;
        vm.prank(holder);
        try vaults[i].withdrawReserveBtc(amount) {
            _holderOp(i, 0, holder.balance - btc, before);
        } catch {}
    }

    function fundReserveMusd(uint256 pSeed, uint256 amount) external {
        calls["fundReserveMusd"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 1e18, 600e18);
        _fund(holder, amount, address(vaults[i]));
        uint256[] memory before = _snap();
        vm.prank(holder);
        try vaults[i].fundReserveMusd(amount) {
            _holderOp(i, 0, 0, before);
        } catch {}
    }

    function withdrawReserveMusd(uint256 pSeed, uint256 amount) external {
        calls["withdrawReserveMusd"]++;
        (uint256 i, address holder) = _pick(pSeed);
        amount = bound(amount, 0, vaults[i].reserveMusd());
        uint256[] memory before = _snap();
        vm.prank(holder);
        try vaults[i].withdrawReserveMusd(amount) {
            _holderOp(i, 0, 0, before);
        } catch {}
    }

    function setPolicy(uint256 pSeed, uint256 a, uint256 b, uint256 c) external {
        calls["setPolicy"]++;
        (uint256 i, address holder) = _pick(pSeed);
        uint256 floor = bound(a, 1.12e18, 2e18);
        uint256 target = floor + bound(b, 0.05e18, 2e18);
        uint256 maxBtc = bound(c, 1e13, 0.2e18);
        uint256 buffer = a % 3 == 0 ? bound(b >> 8, 100e18, 50_000e18) : 0;
        TrozuVault.Policy memory p = _policy(floor, target, maxBtc, buffer);
        p.maxActionMusd = bound(c >> 8, 0, 300e18);
        p.periodCapMusd = p.maxActionMusd * bound(c >> 16, 1, 4);
        p.keeperTipBtc = bound(c >> 24, 0, 2e14);
        if (p.keeperTipBtc >= p.periodCapBtc) p.keeperTipBtc = 0;
        p.period = uint32(bound(c >> 32, 1 hours, 30 days));
        vm.prank(holder);
        try vaults[i].setPolicy(p) {
            policySet[i] = true;
            policyEpoch[i] = nft.transferEpoch(ids[i]);
        } catch {}
    }

    function clearPolicy(uint256 pSeed) external {
        calls["clearPolicy"]++;
        (uint256 i, address holder) = _pick(pSeed);
        vm.prank(holder);
        try vaults[i].clearPolicy() {
            policySet[i] = false;
        } catch {}
    }

    /// A keeper tries the guardian. The handler works out on its own whether a policy
    /// should be live, and checks every bound after a success.
    function executeGuardian(uint256 pSeed) external {
        calls["executeGuardian"]++;
        if (vaults.length == 0) return;
        uint256 i = pSeed % vaults.length;
        TrozuVault v = vaults[i];
        bool live = policySet[i] && policyEpoch[i] == nft.transferEpoch(ids[i]);
        uint256[] memory before = _snap();
        uint256 kb = keeperAddr.balance;
        vm.prank(keeperAddr);
        try v.execute(address(0), address(0)) returns (TrozuVault.Kind k, uint256 amt, uint256 tip) {
            if (!live) guardianViolations++;
            uint256 take = keeperAddr.balance - kb;
            if (take != tip || take > v.MAX_KEEPER_TIP()) guardianViolations++;
            _holderOp(i, 0, take, before);
            TrozuVault.Policy memory p = v.policy();
            if (v.spentBtc() > p.periodCapBtc || v.spentMusd() > p.periodCapMusd) guardianViolations++;
            if (amt > (k == TrozuVault.Kind.RepayMusd ? p.maxActionMusd : p.maxActionBtc)) guardianViolations++;
            if (tip > p.keeperTipBtc) guardianViolations++;
            guardianActions++;
        } catch {
            // a refusal moves nothing
            if (keeperAddr.balance != kb) guardianViolations++;
            _expectUnchanged(before);
        }
    }

    function list(uint256 pSeed, uint256 priceSeed, uint256 durSeed, bool dutch) external {
        calls["list"]++;
        (uint256 i, address holder) = _pick(pSeed);
        if (recs.length >= 14) return;
        uint256 hi = bound(priceSeed, 500e18, 5000e18);
        uint256 dur = bound(durSeed, 1 hours, 3 days);
        TrozuMarket.Listing memory l = TrozuMarket.Listing({
            seller: holder,
            tokenId: ids[i],
            epoch: nft.transferEpoch(ids[i]),
            startPrice: hi,
            endPrice: dutch ? hi / 2 : hi,
            startTime: uint64(block.timestamp),
            endTime: dutch ? uint64(block.timestamp + dur) : 0,
            deadline: uint64(block.timestamp + bound(durSeed >> 8, 2 days, 10 days)),
            nonce: d.market.sellerNonce(holder),
            salt: recs.length
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_keyOf(holder), d.market.hashListing(l));
        vm.prank(holder);
        nft.setApprovalForAll(address(d.market), true);
        recs.push(Rec({l: l, sig: abi.encodePacked(r, s, v), cancelled: false, sold: false}));
    }

    function cancelListing(uint256 lSeed) external {
        calls["cancelListing"]++;
        if (recs.length == 0) return;
        Rec storage rc = recs[lSeed % recs.length];
        vm.prank(rc.l.seller);
        try d.market.cancel(rc.l) {
            rc.cancelled = true;
        } catch {}
    }

    function cancelAllListings(uint256 aSeed) external {
        calls["cancelAllListings"]++;
        address who = actors[aSeed % actors.length];
        vm.prank(who);
        d.market.cancelAll();
        nonceOf[who]++;
    }

    /// Buy attempt. Mode 0 is an honest buyer; the others set a bound the position cannot meet.
    function buy(uint256 lSeed, uint256 buyerSeed, uint256 mode) external {
        calls["buy"]++;
        if (recs.length == 0) return;
        Rec storage rc = recs[lSeed % recs.length];
        address buyer = actors[buyerSeed % actors.length];
        if (buyer == rc.l.seller) return;

        uint256 price = d.market.priceAt(rc.l, block.timestamp);
        _fund(buyer, price + 1e18, address(d.market));

        TrozuMarket.Bounds memory b;
        {
            (uint256 coll, uint256 p, uint256 it,,,) = d.tm.getEntireDebtAndColl(nft.vaultOf(rc.l.tokenId));
            b = TrozuMarket.Bounds({
                expectedEpoch: rc.l.epoch,
                minColl: coll,
                maxDebt: p + it + 1e18,
                minRateBps: 0,
                maxRateBps: 10_000,
                maxPrice: price
            });
            uint256 m = mode % 4;
            if (m == 1) b.expectedEpoch += 1;
            else if (m == 2) b.minColl = coll + 1;
            else if (m == 3) b.maxPrice = price == 0 ? 0 : price - 1;
        }

        bool mustFail = _mustFail(rc) || mode % 4 != 0;
        uint256 buyerBefore = d.musd.balanceOf(buyer);
        uint256 sellerBefore = d.musd.balanceOf(rc.l.seller);
        uint256 feeBefore = d.musd.balanceOf(d.feeRecipient);
        address ownerBefore = nft.ownerOf(rc.l.tokenId);

        vm.prank(buyer);
        try d.market.buy(rc.l, rc.sig, b, buyer, TrozuMarket.PermitData(0, 0, 0, 0)) returns (uint256 pr, uint256 fee) {
            if (mustFail) marketViolations++;
            if (buyerBefore - d.musd.balanceOf(buyer) != pr) marketViolations++;
            if (d.musd.balanceOf(rc.l.seller) - sellerBefore != pr - fee) marketViolations++;
            if (d.musd.balanceOf(d.feeRecipient) - feeBefore != fee) marketViolations++;
            if (fee != (pr * 25 + 9999) / 10_000) marketViolations++;
            if (pr > rc.l.startPrice || pr < rc.l.endPrice) marketViolations++;
            if (nft.ownerOf(rc.l.tokenId) != buyer) marketViolations++;
            rc.sold = true;
            marketSales++;
            uint256 j = _indexOfToken(rc.l.tokenId);
            history[j].push(holders[j]);
            holders[j] = buyer;
        } catch {
            // a refusal moves nothing
            if (d.musd.balanceOf(buyer) != buyerBefore) marketViolations++;
            if (d.musd.balanceOf(rc.l.seller) != sellerBefore) marketViolations++;
            if (d.musd.balanceOf(d.feeRecipient) != feeBefore) marketViolations++;
            if (nft.ownerOf(rc.l.tokenId) != ownerBefore) marketViolations++;
        }
    }

    // Independent of the market's own checks: cancelled, sold, expired, not started, signed under an
    // older owner or epoch, or revoked by cancelAll. None of these may ever settle.
    function _mustFail(Rec storage rc) internal view returns (bool) {
        uint256 j = _indexOfToken(rc.l.tokenId);
        return rc.cancelled || rc.sold || block.timestamp > rc.l.deadline || block.timestamp < rc.l.startTime
            || nft.transferEpoch(rc.l.tokenId) != rc.l.epoch || nonceOf[rc.l.seller] != rc.l.nonce
            || holders[j] != rc.l.seller;
    }

    function _indexOfToken(uint256 tokenId) internal view returns (uint256) {
        for (uint256 j; j < ids.length; j++) {
            if (ids[j] == tokenId) return j;
        }
        revert("unknown token");
    }

    function _keyOf(address who) internal view returns (uint256) {
        for (uint256 k; k < actors.length; k++) {
            if (actors[k] == who) return actorKeys[k];
        }
        revert("no key");
    }

    /// List and buy in one step, so that settlements really happen under fuzzing.
    function sellThrough(uint256 pSeed, uint256 buyerSeed, uint256 priceSeed, bool dutch, uint256 elapsed) external {
        calls["sellThrough"]++;
        uint256 n = recs.length;
        this.list(pSeed, priceSeed, 1 hours + (elapsed % 3 days), dutch);
        if (recs.length == n) return;
        vm.warp(block.timestamp + (elapsed % 2 hours));
        this.buy(recs.length - 1, buyerSeed, 0);
    }

    /// Fund a reserve, set a policy just above the position's ratio, drop the price a little and
    /// let a keeper in, so that guardian actions really happen under fuzzing.
    function guardScenario(uint256 pSeed, uint256 dropSeed) external {
        calls["guardScenario"]++;
        (uint256 i, address holder) = _pick(pSeed);
        uint256 icr = d.tm.getCurrentICR(address(vaults[i]), price * 1e18);
        if (icr < 1.25e18 || icr > 2e18) return;
        this.fundReserveBtc(pSeed, 0.1e18);
        TrozuVault.Policy memory p = _policy(icr + 0.05e18, icr + 0.4e18, 0.2e18, 0);
        vm.prank(holder);
        try vaults[i].setPolicy(p) {
            policySet[i] = true;
            policyEpoch[i] = nft.transferEpoch(ids[i]);
        } catch {
            return;
        }
        this.movePrice(price * (90 + dropSeed % 6) / 100);
        this.executeGuardian(pSeed);
    }

    function listingCount() external view returns (uint256) {
        return recs.length;
    }

    function _open(address who, uint256 debt, uint256 icrBps) internal {
        uint256 coll = _collFor(debt, icrBps);
        uint256[] memory before = _snap();
        vm.deal(who, who.balance + coll);
        vm.prank(who);
        try d.factory.openPosition{value: coll}(debt, address(0), address(0), debt / 100) returns (
            uint256 id, address v
        ) {
            vaults.push(TrozuVault(payable(v)));
            ids.push(id);
            holders.push(who);
            uint256[] memory afterL = _snap();
            for (uint256 j; j < before.length; j++) {
                if (afterL[j] != before[j]) ledgerViolations++;
            }
            if (afterL[afterL.length - 1] != coll) ledgerViolations++;
            ghostIn += coll;
        } catch {}
    }

    function _pick(uint256 seed) internal view returns (uint256 i, address holder) {
        require(vaults.length > 0, "no positions");
        i = seed % vaults.length;
        holder = holders[i];
    }

    function _collFor(uint256 debt, uint256 icrBps) internal view returns (uint256) {
        uint256 composite = debt + debt / 1000 + 200e18;
        return composite * icrBps * 1e18 / (10_000 * price * 1e18);
    }

    function _coll(uint256 i) internal view returns (uint256 c) {
        (c,,,,,) = d.tm.getEntireDebtAndColl(address(vaults[i]));
        if (c == 0) c = 1;
    }

    // collateral plus claimable surplus plus BTC reserve, per vault
    function _snap() internal view returns (uint256[] memory l) {
        l = new uint256[](vaults.length);
        for (uint256 i; i < vaults.length; i++) {
            (uint256 c,,,,,) = d.tm.getEntireDebtAndColl(address(vaults[i]));
            l[i] = c + d.surplus.getCollateral(address(vaults[i])) + vaults[i].reserveBtc();
        }
    }

    // a holder action moves only its own vault's ledger, by exactly in minus out
    function _holderOp(uint256 i, uint256 btcIn, uint256 btcOut, uint256[] memory before) internal {
        uint256[] memory afterL = _snap();
        for (uint256 j; j < before.length; j++) {
            if (j == i) {
                if (afterL[j] + btcOut != before[j] + btcIn) ledgerViolations++;
            } else if (afterL[j] != before[j]) {
                ledgerViolations++;
            }
        }
        ghostIn += btcIn;
        ghostOut += btcOut;
    }

    function _expectUnchanged(uint256[] memory before) internal {
        uint256[] memory afterL = _snap();
        for (uint256 j; j < before.length; j++) {
            if (afterL[j] != before[j]) externalViolations++;
        }
    }

    function _mintTo(address who, uint256 amount) internal {
        if (d.musd.balanceOf(who) >= amount) return;
        uint256 missing = amount - d.musd.balanceOf(who);
        vm.prank(address(d.bo));
        d.musd.mint(who, missing);
    }

    function _fund(address who, uint256 amount, address spender) internal {
        _mintTo(who, amount);
        vm.prank(who);
        d.musd.approve(spender, type(uint256).max);
    }
}
