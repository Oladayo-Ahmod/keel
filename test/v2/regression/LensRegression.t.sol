// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {TrozuBase} from "../TrozuBase.sol";
import {TrozuVault} from "../../../src/v2/TrozuVault.sol";
import {PositionLens} from "../../../src/PositionLens.sol";

contract PositionLensTestV2 is TrozuBase {
    function test_positionInfoMatchesMezo() public {
        (uint256 id, TrozuVault vault) = _openStandard(alice);
        PositionLens.Info memory info = lens.positionInfo(id);

        assertEq(info.vault, address(vault));
        assertEq(info.holder, alice);
        assertTrue(info.active);
        assertEq(info.coll, 0.05e18);
        assertEq(info.debt, 2000e18 + 2e18 + 200e18);
        assertEq(info.price, 60_000e18);
        assertTrue(info.priceOk);
        assertEq(info.icr, troveManager.getCurrentICR(address(vault), 60_000e18));
        assertEq(info.equity, int256(0.05e18 * 60_000) - int256(info.debt));
        assertEq(info.lockedRateBps, 100);
        assertEq(info.globalRateBps, 100);
        assertEq(info.spreadBps, 0);
        assertEq(info.annualSpreadMusd, 0);
        assertTrue(info.redeemable);
        assertTrue(info.canClose);
        assertFalse(info.recoveryMode);
        assertEq(info.claimableSurplus, 0);
    }

    function test_interestAccruesInTheLensWithoutTouchingTheTrove() public {
        (uint256 id, TrozuVault vault) = _openStandard(alice);
        uint256 debtAtOpen = lens.positionInfo(id).debt;
        vm.warp(block.timestamp + 365 days);
        PositionLens.Info memory info = lens.positionInfo(id);
        // 1% simple interest on the principal, per year
        assertGt(info.interest, 20e18);
        assertEq(info.debt, _debtOf(address(vault)));
        assertGt(info.debt, debtAtOpen);
    }

    function test_rateSpreadWhenGlobalRateRises() public {
        (uint256 id,) = _openStandard(alice);
        setGlobalRate(300);
        PositionLens.Info memory info = lens.positionInfo(id);
        assertEq(info.lockedRateBps, 100);
        assertEq(info.globalRateBps, 300);
        assertEq(info.spreadBps, 200);
        // principal * 200 / 10_000
        assertEq(info.annualSpreadMusd, int256(info.principal) * 200 / 10_000);
        assertGt(info.annualSpreadMusd, 0);
    }

    function test_rateSpreadIsNegativeWhenGlobalRateFalls() public {
        (uint256 id,) = _openStandard(alice);
        setGlobalRate(40);
        assertEq(lens.positionInfo(id).spreadBps, -60);
        assertLt(lens.positionInfo(id).annualSpreadMusd, 0);
    }

    function test_refinanceFeeEstimateIsCloseToTheRealFee() public {
        (uint256 id, TrozuVault vault) = _openStandard(alice);
        setGlobalRate(50);
        uint256 estimate = lens.positionInfo(id).refinanceFeeEstimate;
        uint256 before = _debtOf(address(vault));
        vm.prank(alice);
        vault.refinance(address(0), address(0), 5e18, 1);
        uint256 actual = _debtOf(address(vault)) - before;
        assertApproxEqAbs(estimate, actual, 0.01e18);
    }

    function test_positionsOfListsByHolder() public {
        (uint256 a1,) = _openStandard(alice);
        (uint256 a2,) = _openStandard(bob);
        vm.prank(bob);
        nft.transferFrom(bob, alice, a2);
        uint256[] memory ids = lens.positionsOf(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], a1);
        assertEq(ids[1], a2);
        assertEq(lens.positionsOf(bob).length, 0);
    }

    // --- redemption buffer ---

    // three positions in list order: low (120%), mid (200%), high (300%)
    function _ladder() internal returns (uint256 low, uint256 mid, uint256 high) {
        (low,) = _open(alice, 2000e18, 0.044e18);
        (mid,) = _open(bob, 2000e18, 0.073e18);
        (high,) = _open(carol, 2000e18, 0.11e18);
    }

    function test_bufferIsZeroForTheFirstTroveInOrder() public {
        (uint256 low,,) = _ladder();
        PositionLens.Buffer memory b = lens.redemptionBuffer(low, 100);
        assertTrue(b.complete);
        assertEq(b.buffer, 0);
        assertEq(b.eligibleAhead, 0);
    }

    function test_bufferSumsTheTrovesAhead() public {
        (uint256 low, uint256 mid, uint256 high) = _ladder();
        uint256 lowDebt = lens.positionInfo(low).debt;
        uint256 midDebt = lens.positionInfo(mid).debt;

        PositionLens.Buffer memory bMid = lens.redemptionBuffer(mid, 100);
        assertTrue(bMid.complete);
        assertEq(bMid.buffer, lowDebt - GAS_COMP);
        assertEq(bMid.eligibleAhead, 1);

        PositionLens.Buffer memory bHigh = lens.redemptionBuffer(high, 100);
        assertTrue(bHigh.complete);
        assertEq(bHigh.buffer, lowDebt + midDebt - 2 * GAS_COMP);
        assertEq(bHigh.eligibleAhead, 2);
    }

    function test_bufferMatchesWhatARedemptionActuallyConsumes() public {
        (, uint256 mid,) = _ladder();
        uint256 buffer = lens.redemptionBuffer(mid, 100).buffer;
        address redeemer = makeAddr("redeemer");
        openBackgroundTrove(redeemer, 5000e18, 0.3e18);

        // redeeming exactly the buffer must not touch the mid position
        uint256 collBefore = lens.positionInfo(mid).coll;
        vm.prank(redeemer);
        troveManager.redeemCollateral(buffer, address(0), address(0), address(0), 0, 0);
        assertEq(lens.positionInfo(mid).coll, collBefore);
        assertEq(lens.redemptionBuffer(mid, 100).buffer, 0);

        // one more MUSD and it is reached
        TrozuVault v = TrozuVault(payable(nft.vaultOf(mid)));
        uint256 collBefore2 = _collOf(address(v));
        (, uint256 principal,,,,) = troveManager.getEntireDebtAndColl(address(v));
        uint256 newColl = collBefore2 - 1e18 * 1e18 / (PRICE * 1e18);
        uint256 nicr = newColl * 1e20 / (principal - 1e18);
        vm.prank(redeemer);
        troveManager.redeemCollateral(1e18, address(v), address(0), address(0), nicr, 0);
        assertLt(_collOf(address(v)), collBefore2);
    }

    function test_cappedWalkIsALowerBoundNotComplete() public {
        (, , uint256 high) = _ladder();
        PositionLens.Buffer memory full = lens.redemptionBuffer(high, 100);
        PositionLens.Buffer memory capped = lens.redemptionBuffer(high, 1);
        assertTrue(full.complete);
        assertFalse(capped.complete);
        assertEq(capped.steps, 1);
        assertLt(capped.buffer, full.buffer);
    }

    function test_walkEndingExactlyAtTheTroveIsComplete() public {
        (, uint256 mid,) = _ladder();
        // exactly one trove ahead, cap of one: the walk reaches the vault
        PositionLens.Buffer memory b = lens.redemptionBuffer(mid, 1);
        assertTrue(b.complete);
        assertEq(b.steps, 1);
    }

    function test_verdicts() public {
        (, , uint256 high) = _ladder();
        uint256 exact = lens.redemptionBuffer(high, 100).buffer;

        // reaches the threshold: Above, even on a capped walk
        (PositionLens.Verdict v, PositionLens.Buffer memory b) = lens.bufferAtLeast(high, 1000e18, 1);
        assertEq(uint8(v), uint8(PositionLens.Verdict.Above));
        assertFalse(b.complete);

        // threshold above the real buffer, complete walk: Below
        (v, b) = lens.bufferAtLeast(high, exact + 1, 100);
        assertEq(uint8(v), uint8(PositionLens.Verdict.Below));
        assertTrue(b.complete);

        // same threshold, cap too small to finish: only Unknown, never Below
        (v, b) = lens.bufferAtLeast(high, exact + 1, 1);
        assertEq(uint8(v), uint8(PositionLens.Verdict.Unknown));
        assertFalse(b.complete);

        // exactly at the threshold counts as Above
        (v,) = lens.bufferAtLeast(high, exact, 100);
        assertEq(uint8(v), uint8(PositionLens.Verdict.Above));
    }

    function test_liquidatableTrovesAreSkippedAndEatSteps() public {
        (, uint256 mid, uint256 high) = _ladder();
        // at 54k the low trove (120% at 60k) is at 108%, below MCR, but still in the list
        setPrice(54_000);
        PositionLens.Buffer memory b = lens.redemptionBuffer(high, 100);
        assertTrue(b.complete);
        assertEq(b.eligibleAhead, 1, "only the mid trove counts");
        assertEq(b.buffer, lens.positionInfo(mid).debt - GAS_COMP);
        assertEq(b.steps, 2, "the skipped trove still costs a step");

        // a cap of one stops inside the skipped trove: nothing proven
        PositionLens.Buffer memory capped = lens.redemptionBuffer(high, 1);
        assertFalse(capped.complete);
        assertEq(capped.buffer, 0);
    }

    function test_inactivePositionHasNoBuffer() public {
        (uint256 id, TrozuVault vault) = _openStandard(alice);
        _fundMusd(alice, 50e18);
        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);
        vault.close();
        vm.stopPrank();
        PositionLens.Buffer memory b = lens.redemptionBuffer(id, 100);
        assertFalse(b.inList);
        assertFalse(b.complete);
        assertFalse(lens.positionInfo(id).active);
        assertFalse(lens.positionInfo(id).redeemable);
    }

    function test_oracleFailureIsReportedNotZero() public {
        (uint256 id,) = _openStandard(alice);
        aggregator.setBlockTime(1); // stale answer, PriceFeed reverts
        PositionLens.Info memory info = lens.positionInfo(id);
        assertFalse(info.priceOk);
        assertEq(info.price, 0);
        assertFalse(info.redeemable);
        assertFalse(info.canClose);
        // the walk gives up instead of guessing
        PositionLens.Buffer memory b = lens.redemptionBuffer(id, 100);
        assertFalse(b.complete);
    }
}
