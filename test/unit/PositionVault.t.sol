// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {KeelBase} from "../helpers/KeelBase.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {ITroveManager} from "../../src/interfaces/mezo/IMezo.sol";

contract PositionVaultTest is KeelBase {
    uint256 internal id;
    PositionVault internal vault;

    function setUp() public override {
        super.setUp();
        (id, vault) = _openStandard(alice);
    }

    function _noIdleFunds() internal view {
        assertEq(address(vault).balance, 0, "vault btc");
        assertEq(musd.balanceOf(address(vault)), 0, "vault musd");
    }

    // --- open ---

    function test_openMintsNftAndTrove() public view {
        assertEq(nft.ownerOf(id), alice);
        assertEq(nft.vaultOf(id), address(vault));
        assertEq(vault.tokenId(), id);
        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.active));
        assertEq(_collOf(address(vault)), 0.05e18);
        assertEq(musd.balanceOf(alice), 2000e18);
        _noIdleFunds();
    }

    function test_openRevertsIfFeeAboveMax() public {
        vm.deal(bob, 1e18);
        vm.prank(bob);
        // fee is 0.1% of 2000 = 2 MUSD
        vm.expectRevert(abi.encodeWithSelector(PositionVault.FeeTooHigh.selector, 2e18, 1e18));
        factory.openPosition{value: 0.05e18}(2000e18, address(0), address(0), 1e18);
    }

    function test_cannotInitializeAgain() public {
        vm.expectRevert(PositionVault.OnlyFactory.selector);
        vault.initializeAndOpen(9, alice, 2000e18, address(0), address(0), 1e18);

        vm.prank(address(factory));
        vm.expectRevert(PositionVault.AlreadyInitialized.selector);
        vault.initializeAndOpen(9, alice, 2000e18, address(0), address(0), 1e18);
    }

    function test_implementationIsNotUsable() public {
        PositionVault impl = factory.implementation();
        vm.prank(address(factory));
        vm.expectRevert(PositionVault.AlreadyInitialized.selector);
        impl.initializeAndOpen(1, alice, 2000e18, address(0), address(0), 1e18);
    }

    // --- collateral ---

    function test_addCollateral() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vault.addCollateral{value: 0.01e18}(address(0), address(0));
        assertEq(_collOf(address(vault)), 0.06e18);
        _noIdleFunds();
    }

    function test_withdrawCollateralGoesToHolder() public {
        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdrawCollateral(0.005e18, address(0), address(0));
        assertEq(alice.balance - before, 0.005e18);
        assertEq(_collOf(address(vault)), 0.045e18);
        _noIdleFunds();
    }

    // --- debt ---

    function test_borrowMintsToHolder() public {
        vm.prank(alice);
        vault.borrow(100e18, address(0), address(0), 1e18);
        assertEq(musd.balanceOf(alice), 2100e18);
        _noIdleFunds();
    }

    function test_borrowRevertsIfFeeAboveMax() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.FeeTooHigh.selector, 0.1e18, 0.05e18));
        vault.borrow(100e18, address(0), address(0), 0.05e18);
    }

    function test_repayPullsFromHolder() public {
        uint256 debtBefore = _debtOf(address(vault));
        vm.startPrank(alice);
        musd.approve(address(vault), 100e18);
        vault.repay(100e18, address(0), address(0));
        vm.stopPrank();
        assertEq(musd.balanceOf(alice), 1900e18);
        assertEq(_debtOf(address(vault)), debtBefore - 100e18);
        _noIdleFunds();
    }

    function test_repayWithoutAllowanceReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.repay(100e18, address(0), address(0));
    }

    function test_adjustAddsCollateralAndBorrows() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vault.adjust{value: 0.01e18}(0, 100e18, true, address(0), address(0), 1e18);
        assertEq(_collOf(address(vault)), 0.06e18);
        assertEq(musd.balanceOf(alice), 2100e18);
        _noIdleFunds();
    }

    function test_adjustWithdrawsAndRepays() public {
        uint256 btcBefore = alice.balance;
        vm.startPrank(alice);
        musd.approve(address(vault), 100e18);
        vault.adjust(0.002e18, 100e18, false, address(0), address(0), 0);
        vm.stopPrank();
        assertEq(alice.balance - btcBefore, 0.002e18);
        assertEq(musd.balanceOf(alice), 1900e18);
        _noIdleFunds();
    }

    // --- refinance ---

    function test_refinanceLowersRate() public {
        setGlobalRate(50);
        uint256 debtBefore = _debtOf(address(vault));
        vm.prank(alice);
        vault.refinance(address(0), address(0), 5e18, 10);
        assertEq(troveManager.getTroveInterestRate(address(vault)), 50);
        // fee is added to the debt: 0.02% of net debt
        assertGt(_debtOf(address(vault)), debtBefore);
        assertLt(_debtOf(address(vault)) - debtBefore, 1e18);
    }

    function test_refinanceRevertsWhenRateNotLower() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.NoRateImprovement.selector, 100, 100));
        vault.refinance(address(0), address(0), 5e18, 0);
    }

    function test_refinanceRevertsWhenGlobalRateIsHigher() public {
        setGlobalRate(300);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.NoRateImprovement.selector, 100, 300));
        vault.refinance(address(0), address(0), 5e18, 0);
        // the raw Mezo call would have raised the rate, which is what this guards against
        assertEq(troveManager.getTroveInterestRate(address(vault)), 100);
    }

    function test_refinanceRevertsWhenDropBelowMinimum() public {
        setGlobalRate(95);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionVault.NoRateImprovement.selector, 100, 95));
        vault.refinance(address(0), address(0), 5e18, 10);
    }

    function test_refinanceOneBpIsEnoughWhenMinimumIsZero() public {
        setGlobalRate(99);
        vm.prank(alice);
        vault.refinance(address(0), address(0), 5e18, 0);
        assertEq(troveManager.getTroveInterestRate(address(vault)), 99);
    }

    function test_refinanceRevertsWhenFeeAboveMax() public {
        setGlobalRate(50);
        vm.prank(alice);
        vm.expectRevert();
        vault.refinance(address(0), address(0), 0, 10);
        assertEq(troveManager.getTroveInterestRate(address(vault)), 100);
    }

    // --- close ---

    function test_closeReturnsCollateralAndClearsVault() public {
        _fundMusd(alice, 50e18);
        uint256 cost = _debtOf(address(vault)) - GAS_COMP;
        uint256 btcBefore = alice.balance;
        vm.startPrank(alice);
        musd.approve(address(vault), cost);
        vault.close();
        vm.stopPrank();
        assertEq(alice.balance - btcBefore, 0.05e18);
        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.closedByOwner));
        assertEq(musd.balanceOf(alice), 2050e18 - cost);
        _noIdleFunds();
    }

    function test_closeThenReopen() public {
        _fundMusd(alice, 50e18);
        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);
        vault.close();
        vm.deal(alice, 1e18);
        vault.open{value: 0.05e18}(2000e18, address(0), address(0), 2e18);
        vm.stopPrank();
        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.active));
        assertEq(_collOf(address(vault)), 0.05e18);
    }

    // --- access ---

    function _holderCalls() internal view returns (bytes[] memory calls) {
        calls = new bytes[](9);
        calls[0] = abi.encodeCall(vault.open, (2000e18, address(0), address(0), 1e18));
        calls[1] = abi.encodeCall(vault.addCollateral, (address(0), address(0)));
        calls[2] = abi.encodeCall(vault.withdrawCollateral, (1, address(0), address(0)));
        calls[3] = abi.encodeCall(vault.borrow, (100e18, address(0), address(0), 1e18));
        calls[4] = abi.encodeCall(vault.repay, (1e18, address(0), address(0)));
        calls[5] = abi.encodeCall(vault.refinance, (address(0), address(0), 1e18, 1));
        calls[6] = abi.encodeCall(vault.close, ());
        calls[7] = abi.encodeCall(vault.claimSurplus, ());
        calls[8] = abi.encodeCall(vault.sweep, (address(0)));
    }

    function test_nonHolderCannotCallAnything() public {
        bytes[] memory calls = _holderCalls();
        for (uint256 i; i < calls.length; i++) {
            vm.prank(bob);
            (bool ok, bytes memory ret) = address(vault).call(calls[i]);
            assertFalse(ok, "call should revert");
            assertEq(bytes4(ret), PositionVault.NotHolder.selector);
        }
    }

    function test_afterTransferOldHolderAndItsOperatorsHaveNoPower() public {
        address operator = makeAddr("operator");
        vm.startPrank(alice);
        nft.setApprovalForAll(operator, true);
        nft.approve(carol, id);
        nft.transferFrom(alice, bob, id);
        vm.stopPrank();

        bytes[] memory calls = _holderCalls();
        address[3] memory old = [alice, operator, carol];
        for (uint256 a; a < old.length; a++) {
            for (uint256 i; i < calls.length; i++) {
                vm.prank(old[a]);
                (bool ok, bytes memory ret) = address(vault).call(calls[i]);
                assertFalse(ok);
                assertEq(bytes4(ret), PositionVault.NotHolder.selector);
            }
        }
    }

    function test_newHolderControlsPosition() public {
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);

        uint256 before = bob.balance;
        vm.prank(bob);
        vault.withdrawCollateral(0.005e18, address(0), address(0));
        assertEq(bob.balance - before, 0.005e18);
        assertEq(nft.transferEpoch(id), 2); // mint and transfer
    }

    function test_oldAllowanceDoesNotLetNewHolderSpendOldHoldersMusd() public {
        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);
        nft.transferFrom(alice, bob, id);
        vm.stopPrank();

        // bob has no MUSD and no allowance of his own, so the pull fails
        vm.prank(bob);
        vm.expectRevert();
        vault.repay(100e18, address(0), address(0));
        assertEq(musd.balanceOf(alice), 2000e18);
    }

    // --- btc in, sweep ---

    function test_receiveRejectsOtherSenders() public {
        vm.deal(bob, 1e18);
        vm.prank(bob);
        (bool ok, bytes memory ret) = address(vault).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), PositionVault.UnexpectedSender.selector);
    }

    function test_sweepReturnsForcedBtcAndStrayTokens() public {
        // a forced send, as selfdestruct would do
        vm.deal(address(vault), 1 ether);
        _fundMusd(address(vault), 10e18);

        uint256 btcBefore = alice.balance;
        vm.startPrank(alice);
        vault.sweep(address(0));
        vault.sweep(address(musd));
        vm.stopPrank();
        assertEq(alice.balance - btcBefore, 1 ether);
        assertEq(musd.balanceOf(alice), 2010e18);
        _noIdleFunds();
    }

    function test_forcedBtcDoesNotLeakIntoPayouts() public {
        vm.deal(address(vault), 1 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdrawCollateral(0.005e18, address(0), address(0));
        // only the withdrawn amount, the forced balance stays until swept
        assertEq(alice.balance - before, 0.005e18);
        assertEq(address(vault).balance, 1 ether);
    }
}
