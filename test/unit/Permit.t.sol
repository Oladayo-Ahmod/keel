// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {KeelBase} from "../helpers/KeelBase.sol";
import {PositionVault} from "../../src/PositionVault.sol";

/// Threat T21: a front-run permit must not block the holder.
contract PermitTest is KeelBase {
    uint256 internal holderKey = 0xA11CE;
    address internal holder;
    uint256 internal id;
    PositionVault internal vault;

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public override {
        super.setUp();
        holder = vm.addr(holderKey);
        (id, vault) = _openStandard(holder);
    }

    function _sign(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, holder, address(vault), value, musd.nonces(holder), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(holderKey, digest);
    }

    function test_repayWithPermit() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(100e18, block.timestamp + 1 hours);
        uint256 debtBefore = _debtOf(address(vault));
        vm.prank(holder);
        vault.repayWithPermit(100e18, address(0), address(0), block.timestamp + 1 hours, v, r, s);
        assertEq(_debtOf(address(vault)), debtBefore - 100e18);
        assertEq(musd.allowance(holder, address(vault)), 0);
    }

    function test_repayWithPermitSurvivesAFrontRunPermit() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(100e18, deadline);

        // anyone can submit the signature first, which uses up the nonce
        vm.prank(bob);
        musd.permit(holder, address(vault), 100e18, deadline, v, r, s);

        uint256 debtBefore = _debtOf(address(vault));
        vm.prank(holder);
        vault.repayWithPermit(100e18, address(0), address(0), deadline, v, r, s);
        assertEq(_debtOf(address(vault)), debtBefore - 100e18);
    }

    function test_repayWithBadSignatureAndNoAllowanceReverts() public {
        vm.prank(holder);
        vm.expectRevert();
        vault.repayWithPermit(100e18, address(0), address(0), block.timestamp + 1 hours, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_repayWithBadSignatureWorksIfAllowanceExists() public {
        vm.startPrank(holder);
        musd.approve(address(vault), 100e18);
        vault.repayWithPermit(100e18, address(0), address(0), block.timestamp + 1 hours, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        vm.stopPrank();
    }

    function test_permitSignedByHolderIsUselessToTheNewHolder() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(100e18, deadline);
        vm.prank(holder);
        nft.transferFrom(holder, bob, id);

        // the permit is bound to the old holder as owner, so bob's MUSD is what gets pulled
        vm.prank(bob);
        vm.expectRevert();
        vault.repayWithPermit(100e18, address(0), address(0), deadline, v, r, s);
    }

    function test_closeWithPermit() public {
        _fundMusd(holder, 50e18);
        uint256 cost = _debtOf(address(vault)) - GAS_COMP;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(cost, deadline);
        uint256 before = holder.balance;
        vm.prank(holder);
        vault.closeWithPermit(deadline, v, r, s);
        assertEq(holder.balance - before, 0.05e18);
    }

    function test_closeWithPermitSurvivesAFrontRun() public {
        _fundMusd(holder, 50e18);
        uint256 cost = _debtOf(address(vault)) - GAS_COMP;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(cost, deadline);
        vm.prank(bob);
        musd.permit(holder, address(vault), cost, deadline, v, r, s);
        vm.prank(holder);
        vault.closeWithPermit(deadline, v, r, s);
    }
}
