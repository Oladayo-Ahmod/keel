// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {TrozuBase} from "../TrozuBase.sol";
import {TrozuFactory} from "../../../src/v2/TrozuFactory.sol";
import {TrozuNFT} from "../../../src/v2/TrozuNFT.sol";
import {TrozuVault} from "../../../src/v2/TrozuVault.sol";

contract TrozuFactoryTestV2 is TrozuBase {
    function test_idsAreSequentialAndEachPositionHasItsOwnVault() public {
        (uint256 a, TrozuVault va) = _openStandard(alice);
        (uint256 b, TrozuVault vb) = _openStandard(bob);
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
        emit TrozuFactory.PositionCreated(1, address(0), alice);
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
        vm.expectRevert(TrozuNFT.OnlyFactory.selector);
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
        (, TrozuVault v) = _openStandard(alice);
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
    function open(TrozuFactory f) external payable {
        f.openPosition{value: msg.value}(2000e18, address(0), address(0), 2e18);
    }
}
