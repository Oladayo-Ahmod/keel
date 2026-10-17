// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {MUSD} from "musd/token/MUSD.sol";
import {BorrowerOperations} from "musd/BorrowerOperations.sol";
import {TroveManager} from "musd/TroveManager.sol";
import {CollSurplusPool} from "musd/CollSurplusPool.sol";
import {InterestRateManager} from "musd/InterestRateManager.sol";
import {MockAggregator} from "musd/tests/MockAggregator.sol";

import {PositionFactory} from "../../src/PositionFactory.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ITroveManager} from "../../src/interfaces/mezo/IMezo.sol";

struct HandlerDeps {
    PositionFactory factory;
    MUSD musd;
    BorrowerOperations bo;
    TroveManager tm;
    CollSurplusPool surplus;
    InterestRateManager irm;
    MockAggregator aggregator;
    address council;
}

/// Drives KEEL positions through everything that can happen to them: holder
/// actions, transfers, strangers, redemption, liquidation, price, rate and time.
///
/// It keeps a ledger L = collateral + claimable surplus for every vault and
/// checks the movement of L after each step:
///   holder action on vault i:  L[i] moves by exactly (btc in - btc out), others unchanged
///   redemption:                no L increases
///   liquidation:               the liquidated L may fall, every other L may only rise
///   price, rate, time:         every L unchanged
/// Violations are counted and asserted by the invariant suite.
contract KeelHandler is Test {
    HandlerDeps internal d;
    PositionNFT internal nft;

    address[] internal actors;
    address internal redeemer;

    PositionVault[] internal vaults;
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

    mapping(bytes32 => uint256) public calls;

    constructor(HandlerDeps memory deps) {
        d = deps;
        nft = deps.factory.nft();
        actors.push(makeAddr("actor0"));
        actors.push(makeAddr("actor1"));
        actors.push(makeAddr("actor2"));
        actors.push(makeAddr("actor3"));
        redeemer = makeAddr("redeemer");
        for (uint256 i; i < actors.length; i++) {
            vm.deal(actors[i], 1000 ether);
        }
    }

    receive() external payable {}

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function vaultAt(uint256 i) external view returns (PositionVault) {
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

        PositionVault v = vaults[i];
        bytes memory data;
        uint256 k = fnSeed % 8;
        if (k == 0) data = abi.encodeCall(v.withdrawCollateral, (1, address(0), address(0)));
        else if (k == 1) data = abi.encodeCall(v.borrow, (10e18, address(0), address(0), 1e18));
        else if (k == 2) data = abi.encodeCall(v.close, ());
        else if (k == 3) data = abi.encodeCall(v.sweep, (address(0)));
        else if (k == 4) data = abi.encodeCall(v.claimSurplus, ());
        else if (k == 5) data = abi.encodeCall(v.repay, (1e18, address(0), address(0)));
        else if (k == 6) data = abi.encodeCall(v.refinance, (address(0), address(0), 1e18, 1));
        else data = abi.encodeCall(v.open, (2000e18, address(0), address(0), 20e18));

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
        }
    }

    function _open(address who, uint256 debt, uint256 icrBps) internal {
        uint256 coll = _collFor(debt, icrBps);
        uint256[] memory before = _snap();
        vm.deal(who, who.balance + coll);
        vm.prank(who);
        try d.factory.openPosition{value: coll}(debt, address(0), address(0), debt / 100) returns (
            uint256 id, address v
        ) {
            vaults.push(PositionVault(payable(v)));
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

    // collateral plus claimable surplus, per vault
    function _snap() internal view returns (uint256[] memory l) {
        l = new uint256[](vaults.length);
        for (uint256 i; i < vaults.length; i++) {
            (uint256 c,,,,,) = d.tm.getEntireDebtAndColl(address(vaults[i]));
            l[i] = c + d.surplus.getCollateral(address(vaults[i]));
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
