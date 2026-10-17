// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {KeelBase} from "../helpers/KeelBase.sol";
import {Hostile} from "../helpers/Hostile.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {PositionFactory} from "../../src/PositionFactory.sol";

/// Hostile contract holders against the real Mezo contracts (threat T4, T18).
contract ReentrancyTest is KeelBase {
    Hostile internal hostile;
    uint256 internal id;
    PositionVault internal vault;

    function setUp() public override {
        super.setUp();
        hostile = new Hostile();
        vm.deal(address(hostile), 5 ether);

        // the hostile contract opens through the factory and holds the NFT
        bytes memory open =
            abi.encodeCall(PositionFactory.openPosition, (2000e18, address(0), address(0), uint256(2e18)));
        bytes memory ret = hostile.exec{value: 0.05e18}(address(factory), open);
        (uint256 tokenId, address v) = abi.decode(ret, (uint256, address));
        id = tokenId;
        vault = PositionVault(payable(v));
        hostile.approveToken(address(musd), address(vault));
    }

    function _everyEntrypoint() internal view returns (bytes[] memory calls) {
        calls = new bytes[](11);
        calls[0] = abi.encodeCall(vault.open, (2000e18, address(0), address(0), 2e18));
        calls[1] = abi.encodeCall(vault.addCollateral, (address(0), address(0)));
        calls[2] = abi.encodeCall(vault.withdrawCollateral, (1, address(0), address(0)));
        calls[3] = abi.encodeCall(vault.borrow, (100e18, address(0), address(0), 1e18));
        calls[4] = abi.encodeCall(vault.repay, (1e18, address(0), address(0)));
        calls[5] = abi.encodeCall(vault.adjust, (0, 0, false, address(0), address(0), 0));
        calls[6] = abi.encodeCall(vault.refinance, (address(0), address(0), 1e18, 1));
        calls[7] = abi.encodeCall(vault.close, ());
        calls[8] = abi.encodeCall(vault.claimSurplus, ());
        calls[9] = abi.encodeCall(vault.sweep, (address(0)));
        calls[10] = abi.encodeCall(vault.sweep, (address(musd)));
    }

    function _assertAllBlocked() internal view {
        assertEq(hostile.attempted(), 11);
        assertEq(hostile.blocked(), 11, "every re-entry must hit the guard");
        assertEq(address(vault).balance, 0);
        assertEq(musd.balanceOf(address(vault)), 0);
    }

    function test_reenterDuringWithdrawCollateral() public {
        hostile.arm(address(vault), _everyEntrypoint());
        uint256 before = address(hostile).balance;
        hostile.exec(address(vault), abi.encodeCall(vault.withdrawCollateral, (0.005e18, address(0), address(0))));
        assertEq(address(hostile).balance - before, 0.005e18);
        _assertAllBlocked();
    }

    function test_reenterDuringClose() public {
        _fundMusd(address(hostile), 50e18);
        hostile.arm(address(vault), _everyEntrypoint());
        uint256 before = address(hostile).balance;
        hostile.exec(address(vault), abi.encodeCall(vault.close, ()));
        assertEq(address(hostile).balance - before, 0.05e18);
        _assertAllBlocked();
    }

    function test_reenterDuringClaimSurplus() public {
        address redeemer = makeAddr("redeemer");
        openBackgroundTrove(redeemer, 5000e18, 0.3e18);
        uint256 amount = _debtOf(address(vault)) - GAS_COMP;
        vm.prank(redeemer);
        troveManager.redeemCollateral(amount, address(0), address(0), address(0), 0, 0);

        hostile.arm(address(vault), _everyEntrypoint());
        hostile.exec(address(vault), abi.encodeCall(vault.claimSurplus, ()));
        _assertAllBlocked();
        assertGt(address(hostile).balance, 4.9 ether);
    }

    function test_reenterDuringSweep() public {
        vm.deal(address(vault), 1 ether);
        hostile.arm(address(vault), _everyEntrypoint());
        hostile.exec(address(vault), abi.encodeCall(vault.sweep, (address(0))));
        _assertAllBlocked();
    }

    function test_nftMovedAwayDuringPayoutStillPaysTheCaller() public {
        hostile.armTransfer(address(nft), id, bob);
        hostile.arm(address(vault), new bytes[](0));
        uint256 before = address(hostile).balance;
        hostile.exec(address(vault), abi.encodeCall(vault.withdrawCollateral, (0.005e18, address(0), address(0))));

        assertEq(address(hostile).balance - before, 0.005e18);
        assertEq(nft.ownerOf(id), bob);

        // the hostile contract no longer has any power
        vm.expectRevert(PositionVault.NotHolder.selector);
        hostile.exec(address(vault), abi.encodeCall(vault.withdrawCollateral, (1, address(0), address(0))));
    }

    // --- factory mint callback (T18) ---

    function test_reenterFactoryAndVaultFromReceiverHook() public {
        Hostile receiver = new Hostile();
        vm.deal(address(receiver), 1 ether);

        // from the hook: reopen through the factory, which is mid-call
        bytes[] memory attacks = new bytes[](1);
        attacks[0] = abi.encodeCall(PositionFactory.openPosition, (2000e18, address(0), address(0), uint256(2e18)));
        receiver.arm(address(factory), attacks);

        bytes memory open =
            abi.encodeCall(PositionFactory.openPosition, (2000e18, address(0), address(0), uint256(2e18)));
        bytes memory ret = receiver.exec{value: 0.05e18}(address(factory), open);
        (uint256 tokenId, address v) = abi.decode(ret, (uint256, address));

        assertEq(receiver.attempted(), 1);
        assertEq(receiver.blocked(), 1, "factory must be guarded");
        assertEq(nft.ownerOf(tokenId), address(receiver));
        assertEq(factory.totalPositions(), tokenId, "no second position was created");
        assertEq(address(v).balance, 0);
    }

    function test_receiverHookSeesAFinishedPosition() public {
        UsesVaultInHook receiver = new UsesVaultInHook(nft);
        vm.deal(address(receiver), 1 ether);

        bytes memory open =
            abi.encodeCall(PositionFactory.openPosition, (2000e18, address(0), address(0), uint256(2e18)));
        bytes memory ret = receiver.exec{value: 0.05e18}(address(factory), open);
        (uint256 tokenId, address v) = abi.decode(ret, (uint256, address));

        // the hook already used the vault as its holder, and it worked
        assertTrue(receiver.hookSucceeded());
        assertEq(_collOf(v), 0.06e18);
        assertEq(nft.ownerOf(tokenId), address(receiver));
    }
}

/// Uses the vault from inside onERC721Received, which only works if the trove
/// is open and the NFT already belongs to it.
contract UsesVaultInHook {
    PositionNFT internal immutable NFT;
    bool public hookSucceeded;

    constructor(PositionNFT nft) {
        NFT = nft;
    }

    function exec(address to, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: msg.value}(data);
        require(ok, "call failed");
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        PositionVault(payable(NFT.vaultOf(id))).addCollateral{value: 0.01e18}(address(0), address(0));
        hookSucceeded = true;
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
