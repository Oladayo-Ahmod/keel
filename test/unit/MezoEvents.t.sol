// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {KeelBase} from "../helpers/KeelBase.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {PositionLens} from "../../src/PositionLens.sol";
import {ITroveManager} from "../../src/interfaces/mezo/IMezo.sol";

/// What Mezo does to a position without the holder asking: redemption,
/// liquidation, redistribution and Recovery Mode.
contract MezoEventsTest is KeelBase {
    // the test contract is the liquidator and receives the collateral bonus
    receive() external payable {}

    uint256 internal id;
    PositionVault internal vault;
    address internal redeemer = makeAddr("redeemer");

    function setUp() public override {
        super.setUp();
        (id, vault) = _openStandard(alice);
        openBackgroundTrove(redeemer, 5000e18, 0.3e18);
    }

    // --- redemption ---

    function test_fullRedemptionLeavesSurplusAndPositionIsRecoverable() public {
        uint256 amount = _debtOf(address(vault)) - GAS_COMP;
        vm.prank(redeemer);
        troveManager.redeemCollateral(amount, address(0), address(0), address(0), 0, 0);

        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.closedByRedemption));
        uint256 expectedSurplus = 0.05e18 - amount * 1e18 / (PRICE * 1e18);
        assertEq(lens.positionInfo(id).claimableSurplus, expectedSurplus);
        assertFalse(lens.positionInfo(id).active);

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.claimSurplus();
        assertEq(alice.balance - before, expectedSurplus);
        assertEq(address(vault).balance, 0);
        assertEq(lens.positionInfo(id).claimableSurplus, 0);

        // reopen on the same vault
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vault.open{value: 0.05e18}(2000e18, address(0), address(0), 2e18);
        assertTrue(lens.positionInfo(id).active);
    }

    function test_partialRedemptionReducesCollateralAndDebt() public {
        uint256 debtBefore = _debtOf(address(vault));
        uint256 amount = 100e18;
        // hints for the partial redemption: the trove's new NICR and a list position
        (, uint256 principal,,,,) = troveManager.getEntireDebtAndColl(address(vault));
        uint256 newColl = 0.05e18 - amount * 1e18 / (PRICE * 1e18);
        uint256 newNicr = newColl * 1e20 / (principal - amount);
        vm.prank(redeemer);
        troveManager.redeemCollateral(amount, address(vault), address(0), address(0), newNicr, 0);

        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.active));
        assertEq(_debtOf(address(vault)), debtBefore - amount);
        assertEq(_collOf(address(vault)), newColl);
    }

    // --- liquidation and redistribution ---

    function test_liquidationClosesTroveAndVaultCanReopen() public {
        setPrice(45_000);
        troveManager.liquidate(address(vault));
        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.closedByLiquidation));
        assertFalse(lens.positionInfo(id).active);

        setPrice(PRICE);
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vault.open{value: 0.05e18}(2000e18, address(0), address(0), 2e18);
        assertTrue(lens.positionInfo(id).active);
        assertEq(address(vault).balance, 0);
    }

    function test_lensIncludesPendingRedistribution() public {
        (uint256 bobId, PositionVault bobVault) = _open(bob, 2000e18, 0.2e18);

        setPrice(45_000);
        troveManager.liquidate(address(vault));

        // the stored trove is stale until touched, the lens is not
        uint256 stored = troveManager.getTroveColl(address(bobVault));
        PositionLens.Info memory info = lens.positionInfo(bobId);
        assertGt(info.coll, stored);
        (uint256 c, uint256 p, uint256 i,,,) = troveManager.getEntireDebtAndColl(address(bobVault));
        assertEq(info.coll, c);
        assertEq(info.debt, p + i);
        // and it matches what Mezo uses for the ICR
        assertEq(info.icr, troveManager.getCurrentICR(address(bobVault), 45_000e18));
    }

    // --- recovery mode ---

    function test_recoveryModeBlocksExitsButNotRepayOrTopUp() public {
        // one big debtor so the system TCR can be pushed under 150%
        address whale = makeAddr("debtor");
        openBackgroundTrove(whale, 200_000e18, 5.3e18);
        setGlobalRate(50);
        _fundMusd(alice, 50e18);

        setPrice(53_000);
        assertTrue(troveManager.checkRecoveryMode(53_000e18));
        assertTrue(lens.positionInfo(id).recoveryMode);
        assertFalse(lens.positionInfo(id).canClose);

        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);

        vm.expectRevert(bytes("BorrowerOps: Operation not permitted during Recovery Mode"));
        vault.refinance(address(0), address(0), 5e18, 10);

        vm.expectRevert(bytes("BorrowerOps: Operation not permitted during Recovery Mode"));
        vault.close();

        vm.expectRevert(bytes("BorrowerOps: Collateral withdrawal not permitted Recovery Mode"));
        vault.withdrawCollateral(0.001e18, address(0), address(0));

        // repay and top up still work
        vault.repay(10e18, address(0), address(0));
        vm.deal(alice, 1e18);
        vault.addCollateral{value: 0.01e18}(address(0), address(0));
        vm.stopPrank();
        assertEq(_collOf(address(vault)), 0.06e18);
    }

    function test_lastTroveCannotClose() public {
        // make the vault safe enough that the others can close without breaking CCR
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vault.addCollateral{value: 1e18}(address(0), address(0));
        _closeBackground(bg1);
        _closeBackground(bg2);
        _closeBackground(redeemer);
        assertEq(sortedTroves.getSize(), 1);

        // setup shortcut: mint what alice needs to cover the repayment
        vm.prank(address(borrowerOperations));
        musd.mint(alice, 500e18);

        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);
        vm.expectRevert(bytes("TroveManager: Only one trove in the system"));
        vault.close();
        vm.stopPrank();
        assertFalse(lens.positionInfo(id).canClose);
    }

    function _closeBackground(address who) internal {
        // top up from alice's balance so the background owner can repay
        uint256 need = troveManager.getTroveDebt(who) - GAS_COMP;
        uint256 have = musd.balanceOf(who);
        if (have < need) {
            vm.prank(alice);
            musd.transfer(who, need - have);
        }
        vm.prank(who);
        borrowerOperations.closeTrove();
    }
}
