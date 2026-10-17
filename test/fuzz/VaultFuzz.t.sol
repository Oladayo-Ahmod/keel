// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {KeelBase} from "../helpers/KeelBase.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {PositionLens} from "../../src/PositionLens.sol";
import {ITroveManager} from "../../src/interfaces/mezo/IMezo.sol";

contract VaultFuzz is KeelBase {
    // debt between the minimum and a size the background list can still absorb
    function _boundDebt(uint256 x) internal pure returns (uint256) {
        return bound(x, 1800e18, 50_000e18);
    }

    // collateral for the given ICR in basis points at the fixture price
    function _collFor(uint256 debt, uint256 icrBps) internal pure returns (uint256) {
        uint256 composite = debt + debt / 1000 + 200e18;
        return composite * icrBps * 1e18 / (10_000 * PRICE * 1e18);
    }

    /// Open then close returns exactly the collateral and leaves nothing behind.
    function testFuzz_openCloseRoundTrip(uint256 debtSeed, uint256 icrSeed, uint256 elapsed) public {
        uint256 debt = _boundDebt(debtSeed);
        uint256 coll = _collFor(debt, bound(icrSeed, 17_000, 40_000));
        elapsed = bound(elapsed, 0, 365 days);

        (uint256 id, PositionVault vault) = _open(alice, debt, coll);
        assertEq(_collOf(address(vault)), coll);
        assertEq(musd.balanceOf(alice), debt);

        vm.warp(block.timestamp + elapsed);
        uint256 cost = _debtOf(address(vault)) - GAS_COMP;
        // top up whatever interest and fee the opener is short by
        uint256 missing = cost - musd.balanceOf(alice);
        vm.prank(address(borrowerOperations));
        musd.mint(alice, missing);

        uint256 btcBefore = alice.balance;
        vm.startPrank(alice);
        musd.approve(address(vault), cost);
        vault.close();
        vm.stopPrank();

        assertEq(alice.balance - btcBefore, coll);
        assertEq(address(vault).balance, 0);
        assertEq(musd.balanceOf(address(vault)), 0);
        assertEq(musd.balanceOf(alice), 0);
        assertFalse(lens.positionInfo(id).active);
    }

    /// The lens always agrees with Mezo's own ICR, with interest and time in play.
    function testFuzz_lensIcrMatchesMezo(uint256 debtSeed, uint256 icrSeed, uint256 elapsed, uint256 price) public {
        uint256 debt = _boundDebt(debtSeed);
        uint256 coll = _collFor(debt, bound(icrSeed, 17_000, 40_000));
        (uint256 id, PositionVault vault) = _open(alice, debt, coll);

        vm.warp(block.timestamp + bound(elapsed, 0, 730 days));
        price = bound(price, 20_000, 120_000);
        setPrice(price);

        PositionLens.Info memory info = lens.positionInfo(id);
        assertEq(info.icr, troveManager.getCurrentICR(address(vault), price * 1e18));
        assertEq(info.debt, _debtOf(address(vault)));
    }

    /// Refinance succeeds exactly when the global rate is lower by the required drop.
    function testFuzz_refinanceRule(uint16 newRate, uint16 minDrop) public {
        newRate = uint16(bound(newRate, 0, 1000));
        minDrop = uint16(bound(minDrop, 0, 200));
        (, PositionVault vault) = _openStandard(alice);
        setGlobalRate(newRate);

        uint256 required = minDrop == 0 ? 1 : minDrop;
        bool shouldPass = uint256(newRate) + required <= START_RATE;

        vm.prank(alice);
        if (!shouldPass) vm.expectRevert(abi.encodeWithSelector(PositionVault.NoRateImprovement.selector, START_RATE, newRate));
        vault.refinance(address(0), address(0), 5e18, minDrop);

        uint16 locked = troveManager.getTroveInterestRate(address(vault));
        assertEq(locked, shouldPass ? newRate : START_RATE);
    }

    /// After a transfer nobody but the new holder moves funds, whatever they try.
    function testFuzz_onlyCurrentHolderCanMove(address stranger, uint256 which) public {
        (uint256 id, PositionVault vault) = _openStandard(alice);
        vm.assume(stranger != bob && stranger != address(0) && stranger != address(vault));
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);

        vm.startPrank(stranger);
        bytes memory call;
        which = bound(which, 0, 3);
        if (which == 0) call = abi.encodeCall(vault.withdrawCollateral, (1, address(0), address(0)));
        else if (which == 1) call = abi.encodeCall(vault.borrow, (100e18, address(0), address(0), 1e18));
        else if (which == 2) call = abi.encodeCall(vault.close, ());
        else call = abi.encodeCall(vault.sweep, (address(0)));
        (bool ok, bytes memory ret) = address(vault).call(call);
        vm.stopPrank();
        assertFalse(ok);
        assertEq(bytes4(ret), PositionVault.NotHolder.selector);
    }

    /// Whatever sequence of holder actions runs, the vault ends with nothing idle.
    function testFuzz_vaultHoldsNothingAfterAnyOperation(uint256 seed) public {
        (, PositionVault vault) = _openStandard(alice);
        vm.deal(alice, 10 ether);
        vm.startPrank(alice);
        musd.approve(address(vault), type(uint256).max);
        for (uint256 i; i < 6; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i))) % 5;
            if (r == 0) vault.addCollateral{value: 0.01e18}(address(0), address(0));
            else if (r == 1) vault.withdrawCollateral(0.001e18, address(0), address(0));
            else if (r == 2) vault.borrow(50e18, address(0), address(0), 1e18);
            else if (r == 3) vault.repay(10e18, address(0), address(0));
            else vault.adjust{value: 0.002e18}(0, 20e18, true, address(0), address(0), 1e18);
            assertEq(address(vault).balance, 0);
            assertEq(musd.balanceOf(address(vault)), 0);
        }
        vm.stopPrank();
        assertEq(uint8(troveManager.getTroveStatus(address(vault))), uint8(ITroveManager.Status.active));
    }
}
