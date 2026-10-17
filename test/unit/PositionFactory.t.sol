// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {KeelBase} from "../helpers/KeelBase.sol";
import {PositionFactory} from "../../src/PositionFactory.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {PositionVault} from "../../src/PositionVault.sol";

contract PositionFactoryTest is KeelBase {
    function test_idsAreSequentialAndEachPositionHasItsOwnVault() public {
        (uint256 a, PositionVault va) = _openStandard(alice);
        (uint256 b, PositionVault vb) = _openStandard(bob);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(factory.totalPositions(), 2);
        assertTrue(address(va) != address(vb));
        assertEq(nft.vaultOf(a), address(va));
        assertEq(nft.vaultOf(b), address(vb));
    }

    function test_emitsPositionCreated() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vm.expectEmit(true, false, true, false);
        emit PositionFactory.PositionCreated(1, address(0), alice);
        factory.openPosition{value: 0.05e18}(2000e18, address(0), address(0), 2e18);
    }

    function test_openRevertsWhenMezoRejects() public {
        // 1 MUSD is below the minimum net debt
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert();
        factory.openPosition{value: 0.05e18}(1e18, address(0), address(0), 1e18);
        assertEq(factory.totalPositions(), 0);
    }

    function test_openRevertsWhenUnderCollateralised() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert();
        factory.openPosition{value: 0.01e18}(2000e18, address(0), address(0), 2e18);
    }

    function test_onlyFactoryMints() public {
        vm.prank(alice);
        vm.expectRevert(PositionNFT.OnlyFactory.selector);
        nft.mint(alice, 99, address(0));
    }

    function test_epochMovesOnEveryTransfer() public {
        (uint256 id,) = _openStandard(alice);
        assertEq(nft.transferEpoch(id), 1);
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);
        assertEq(nft.transferEpoch(id), 2);
        vm.prank(bob);
        nft.transferFrom(bob, alice, id);
        assertEq(nft.transferEpoch(id), 3);
    }

    function test_cloneIsMinimalProxy() public {
        (, PositionVault v) = _openStandard(alice);
        assertEq(address(v).code.length, 45);
    }

    function test_nftCannotBeMintedToAContractThatRejectsIt() public {
        NoReceiver r = new NoReceiver();
        vm.deal(address(r), 1e18);
        vm.expectRevert();
        r.open{value: 0.05e18}(factory);
        // the whole transaction reverted, so no trove was opened either
        assertEq(factory.totalPositions(), 0);
    }
}

contract NoReceiver {
    function open(PositionFactory f) external payable {
        f.openPosition{value: msg.value}(2000e18, address(0), address(0), 2e18);
    }
}
