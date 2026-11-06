// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {TrozuBase} from "./TrozuBase.sol";
import {TrozuVault} from "../../src/v2/TrozuVault.sol";
import {TrozuFactory} from "../../src/v2/TrozuFactory.sol";

/// Guardian and reserve behaviour.
///
/// The standard position is 2000 MUSD out and 0.05 BTC in: debt 2202 with the fee and
/// gas reserve, ratio 136% at 60k. Price 50k puts it at 113%.
contract GuardianTest is TrozuBase {
    uint256 internal holderKey = 0xA11CE;
    address internal holder;
    uint256 internal id;
    TrozuVault internal vault;

    function setUp() public override {
        super.setUp();
        holder = vm.addr(holderKey);
        (id, vault) = _openStandard(holder);
        vm.deal(holder, 10 ether);
    }

    // ---- helpers ----

    function _policy() internal pure returns (TrozuVault.Policy memory p) {
        p = TrozuVault.Policy({
            epoch: 0,
            floorIcr: 1.3e18,
            targetIcr: 1.5e18,
            maxActionBtc: 0.05e18,
            maxActionMusd: 500e18,
            periodCapBtc: 0.1e18,
            periodCapMusd: 1000e18,
            keeperTipBtc: 1e13,
            bufferFloorMusd: 0,
            period: 1 days,
            maxWalkSteps: 0,
            active: false
        });
    }

    function _setPolicy(TrozuVault.Policy memory p) internal {
        vm.prank(holder);
        vault.setPolicy(p);
    }

    function _fundBtc(uint256 amount) internal {
        vm.prank(holder);
        vault.fundReserveBtc{value: amount}();
    }

    function _fundMusdReserve(uint256 amount) internal {
        _fundMusd(holder, amount);
        vm.startPrank(holder);
        musd.approve(address(vault), amount);
        vault.fundReserveMusd(amount);
        vm.stopPrank();
    }

    function _execute() internal returns (TrozuVault.Kind k, uint256 amount, uint256 tip) {
        vm.prank(keeper);
        return vault.execute(address(0), address(0));
    }

    function _expectNothing(TrozuVault.Reason r) internal {
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.NothingToDo.selector, r));
        vm.prank(keeper);
        vault.execute(address(0), address(0));
    }

    function _icr() internal view returns (uint256) {
        return lens.positionInfo(id).icr;
    }

    // ---- policy validation ----

    function test_policyBoundsAreValidated() public {
        TrozuVault.Policy memory p = _policy();

        p.floorIcr = 1.1e18;
        _expectBad(p, "floor must be above the 110% minimum");
        p = _policy();
        p.targetIcr = p.floorIcr;
        _expectBad(p, "target must be above floor");
        p = _policy();
        p.targetIcr = 5.01e18;
        _expectBad(p, "target above 500%");
        p = _policy();
        p.period = 59 minutes;
        _expectBad(p, "period out of range");
        p.period = 31 days;
        _expectBad(p, "period out of range");
        p = _policy();
        p.keeperTipBtc = vault.MAX_KEEPER_TIP() + 1;
        _expectBad(p, "tip above cap");
        p = _policy();
        p.maxActionBtc = 0;
        p.maxActionMusd = 0;
        _expectBad(p, "no action allowed");
        p = _policy();
        p.maxActionBtc = p.periodCapBtc + 1;
        _expectBad(p, "action cap above period cap");
        p = _policy();
        p.maxActionMusd = p.periodCapMusd + 1;
        _expectBad(p, "action cap above period cap");
        p = _policy();
        p.keeperTipBtc = 1e13;
        p.periodCapBtc = 1e13; // tip equals the cap
        p.maxActionBtc = 1e13;
        _expectBad(p, "tip not below period cap");
        p = _policy();
        p.maxWalkSteps = 101;
        _expectBad(p, "walk too long");
        p = _policy();
        p.bufferFloorMusd = 1000e18; // defense without a walk
        _expectBad(p, "defense needs a walk and a BTC cap");
        p.maxWalkSteps = 5;
        p.maxActionBtc = 0;
        _expectBad(p, "defense needs a walk and a BTC cap");
    }

    function _expectBad(TrozuVault.Policy memory p, string memory why) internal {
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.BadPolicy.selector, why));
        vm.prank(holder);
        vault.setPolicy(p);
    }

    function test_onlyTheHolderTouchesPolicyAndReserve() public {
        TrozuVault.Policy memory p = _policy();
        vm.deal(bob, 1 ether);
        vm.startPrank(bob);
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.setPolicy(p);
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.clearPolicy();
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.fundReserveBtc{value: 1}();
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.fundReserveMusd(1);
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.withdrawReserveBtc(0);
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.withdrawReserveMusd(0);
        vm.stopPrank();
    }

    function test_setPolicyStampsTheEpochAndIgnoresInput() public {
        TrozuVault.Policy memory p = _policy();
        p.epoch = 999;
        p.active = false;
        _setPolicy(p);
        TrozuVault.Policy memory got = vault.policy();
        assertEq(got.epoch, nft.transferEpoch(id));
        assertTrue(got.active);
        assertTrue(vault.policyLive());
    }

    function test_clearPolicyStopsTheGuardian() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        vm.prank(holder);
        vault.clearPolicy();
        setPrice(50_000);
        _expectNothing(TrozuVault.Reason.NoPolicy);
    }

    // ---- policy dies on transfer ----

    function test_policyDiesWhenTheTokenMovesAndStaysDead() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setPrice(50_000);
        assertEq(uint8(vault.preview().kind), uint8(TrozuVault.Kind.TopUpBtc), "live before the transfer");

        vm.prank(holder);
        nft.transferFrom(holder, bob, id);
        assertFalse(vault.policyLive());
        assertEq(uint8(vault.preview().reason), uint8(TrozuVault.Reason.PolicyStale));
        _expectNothing(TrozuVault.Reason.PolicyStale);

        // moving it back does not revive it
        vm.prank(bob);
        nft.transferFrom(bob, holder, id);
        assertFalse(vault.policyLive());
        _expectNothing(TrozuVault.Reason.PolicyStale);

        // and the holder can set a fresh one
        _setPolicy(_policy());
        assertTrue(vault.policyLive());
        _execute();
    }

    function test_reserveStaysWithThePositionAndTheNewHolderCanTakeIt() public {
        _fundBtc(0.2e18);
        _fundMusdReserve(300e18);
        vm.prank(holder);
        nft.transferFrom(holder, bob, id);

        vm.prank(holder);
        vm.expectRevert(TrozuVault.NotHolder.selector);
        vault.withdrawReserveBtc(1);

        uint256 btc0 = bob.balance;
        vm.startPrank(bob);
        vault.withdrawReserveBtc(0.2e18);
        vault.withdrawReserveMusd(300e18);
        vm.stopPrank();
        assertEq(bob.balance - btc0, 0.2e18);
        assertEq(musd.balanceOf(bob), 300e18);
        assertEq(vault.reserveBtc(), 0);
        assertEq(vault.reserveMusd(), 0);
    }

    // ---- ratio floor ----

    function test_topUpRestoresTheTargetRatio() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setPrice(50_000);
        uint256 collBefore = _collOf(address(vault));
        uint256 debt = _debtOf(address(vault));
        uint256 keeperBefore = keeper.balance;

        vm.expectEmit(true, false, false, false);
        emit TrozuVault.GuardianAction(keeper, TrozuVault.Kind.TopUpBtc, 0, 0, 0);
        (TrozuVault.Kind k, uint256 amount, uint256 tip) = _execute();

        assertEq(uint8(k), uint8(TrozuVault.Kind.TopUpBtc));
        assertEq(tip, 1e13);
        assertEq(keeper.balance - keeperBefore, tip, "keeper gets exactly the tip");
        assertEq(_collOf(address(vault)), collBefore + amount, "collateral grew by the amount");
        assertEq(vault.reserveBtc(), 0.2e18 - amount - tip);
        assertEq(address(vault).balance, vault.reserveBtc(), "balance backs the reserve");
        assertGe(_icr(), 1.5e18, "ratio restored to at least the target");
        // not by more than the rounding of one wei of collateral
        assertLe(_icr(), 1.5e18 + 50_000 * 1e18 / debt + 1);
        assertEq(vault.spentBtc(), amount + tip);
    }

    function test_nothingHappensAboveTheFloor() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        _expectNothing(TrozuVault.Reason.Healthy);
        setPrice(52_000); // ratio 118%... floor is 130%
        assertEq(uint8(vault.preview().kind), uint8(TrozuVault.Kind.TopUpBtc));
        setPrice(60_000);
        _expectNothing(TrozuVault.Reason.Healthy);
        assertEq(vault.reserveBtc(), 0.2e18);
    }

    function test_noPolicyNoAction() public {
        _fundBtc(0.2e18);
        setPrice(50_000);
        _expectNothing(TrozuVault.Reason.NoPolicy);
    }

    function test_noReserveNoAction() public {
        _setPolicy(_policy());
        setPrice(50_000);
        _expectNothing(TrozuVault.Reason.NoReserve);
    }

    function test_perActionCapLimitsTheAmount() public {
        TrozuVault.Policy memory p = _policy();
        p.maxActionBtc = 0.005e18;
        _setPolicy(p);
        _fundBtc(0.2e18);
        setPrice(50_000);
        (, uint256 amount,) = _execute();
        assertEq(amount, 0.005e18);
        assertLt(_icr(), 1.5e18, "partial: the cap, not the target, decided");
    }

    function test_periodCapBoundsTotalOutflowAndResets() public {
        TrozuVault.Policy memory p = _policy();
        p.maxActionBtc = 0.005e18;
        p.periodCapBtc = 0.012e18;
        p.maxActionMusd = 0;
        p.periodCapMusd = 0;
        p.keeperTipBtc = 1e13;
        p.floorIcr = 2e18; // high floor and target, so the caps are what stops it
        p.targetIcr = 3e18;
        _setPolicy(p);
        _fundBtc(0.2e18);
        setPrice(50_000);

        uint256 out;
        for (uint256 i; i < 3; i++) {
            (, uint256 a, uint256 t) = _execute();
            out += a + t;
        }
        assertEq(out, 0.012e18, "the third action took exactly what was left");
        assertEq(vault.spentBtc(), 0.012e18);
        _expectNothing(TrozuVault.Reason.NoReserve);

        // before the period ends nothing more, after it a fresh allowance
        vm.warp(block.timestamp + 1 days - 1);
        _expectNothing(TrozuVault.Reason.NoReserve);
        vm.warp(block.timestamp + 2);
        (, uint256 a2,) = _execute();
        assertGt(a2, 0);
        assertLe(vault.spentBtc(), 0.012e18);
    }

    function test_keeperTipIsCappedInCodeAndNeverPaidOnAFailedCall() public {
        TrozuVault.Policy memory p = _policy();
        p.keeperTipBtc = vault.MAX_KEEPER_TIP();
        _setPolicy(p);
        _fundBtc(0.2e18);
        // healthy: the call reverts and the keeper gets nothing
        uint256 before = keeper.balance;
        _expectNothing(TrozuVault.Reason.Healthy);
        assertEq(keeper.balance, before);
        // at the cap
        setPrice(50_000);
        (,, uint256 tip) = _execute();
        assertEq(tip, vault.MAX_KEEPER_TIP());
        assertEq(keeper.balance - before, vault.MAX_KEEPER_TIP());
    }

    function test_tipDropsToZeroWhenTheReserveCannotCoverIt() public {
        TrozuVault.Policy memory p = _policy();
        p.keeperTipBtc = 1e14;
        _setPolicy(p);
        _fundMusdReserve(300e18); // MUSD only, no BTC for a tip
        setPrice(50_000);
        (TrozuVault.Kind k,, uint256 tip) = _execute();
        assertEq(uint8(k), uint8(TrozuVault.Kind.RepayMusd));
        assertEq(tip, 0);
    }

    // ---- what Mezo will accept ----

    function test_anActionThatCannotReachTheMinimumRatioIsNotOffered() public {
        // at 40k the position is at 91%. A top-up capped at 0.005 BTC reaches 100%, still
        // under the 110% Mezo demands in normal mode, so it would revert. The plan says so.
        TrozuVault.Policy memory p = _policy();
        p.maxActionBtc = 0.005e18;
        _setPolicy(p);
        _fundBtc(0.2e18);
        setPrice(40_000);
        assertEq(uint8(vault.preview().reason), uint8(TrozuVault.Reason.BelowMinimum));
        _expectNothing(TrozuVault.Reason.BelowMinimum);
        assertEq(vault.reserveBtc(), 0.2e18, "no keeper gas wasted on a doomed call, no funds moved");
    }

    function test_aLargeEnoughActionCanRescueAPositionUnderTheMinimum() public {
        // same price, but the cap allows enough to get over 110% in one go
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setPrice(40_000);
        assertEq(uint8(vault.preview().kind), uint8(TrozuVault.Kind.TopUpBtc));
        _execute();
        assertGe(_icr(), 1.1e18);
    }

    function test_inRecoveryModeATopUpMustClearTheSystemRatio() public {
        // recovery mode: the system ratio is under 150%
        setPrice(28_000);
        assertTrue(troveManager.checkRecoveryMode(28_000e18));
        uint256 tcr = troveManager.getTCR(28_000e18);
        TrozuVault.Policy memory p = _policy();
        p.maxActionBtc = 0.002e18; // Mezo would accept it, but it leaves the trove far under the system ratio
        _setPolicy(p);
        _fundBtc(0.2e18);
        assertEq(uint8(vault.preview().reason), uint8(TrozuVault.Reason.BelowMinimum));
        _expectNothing(TrozuVault.Reason.BelowMinimum);
        assertEq(vault.reserveBtc(), 0.2e18, "reserve is not fed to a trove that can still be liquidated");

        // an action big enough to put the trove at or over the system ratio is offered
        p.maxActionBtc = 0.1e18;
        p.periodCapBtc = 0.2e18;
        _setPolicy(p);
        TrozuVault.Plan memory plan = vault.preview();
        assertEq(uint8(plan.kind), uint8(TrozuVault.Kind.TopUpBtc));
        _execute();
        assertGe(_icr(), tcr);
    }

    // ---- MUSD repay ----

    function test_repayPathUsesTheMusdReserve() public {
        _setPolicy(_policy());
        _fundMusdReserve(1000e18);
        setPrice(50_000);
        uint256 debtBefore = _debtOf(address(vault));
        (TrozuVault.Kind k, uint256 amount,) = _execute();
        assertEq(uint8(k), uint8(TrozuVault.Kind.RepayMusd));
        assertEq(_debtOf(address(vault)), debtBefore - amount);
        assertEq(vault.reserveMusd(), 1000e18 - amount);
        assertEq(musd.balanceOf(address(vault)), vault.reserveMusd());
        // Mezo's minimum net debt is 1800, so only the part above debt 2000 can be repaid
        assertLe(amount, debtBefore - 2000e18);
    }

    function test_repayStopsAtMezosMinimumDebt() public {
        _setPolicy(_policy());
        _fundMusdReserve(1000e18);
        setPrice(50_000);
        _execute();
        // debt is now at the floor of what Mezo allows, a second repay has no room
        assertEq(_debtOf(address(vault)) >= 2000e18, true);
        setPrice(40_000);
        _expectNothing(TrozuVault.Reason.NoReserve);
    }

    function test_btcIsPreferredOverMusd() public {
        _setPolicy(_policy());
        _fundBtc(0.2e18);
        _fundMusdReserve(500e18);
        setPrice(50_000);
        (TrozuVault.Kind k,,) = _execute();
        assertEq(uint8(k), uint8(TrozuVault.Kind.TopUpBtc));
        assertEq(vault.reserveMusd(), 500e18);
    }

    // ---- redemption defense ----

    function _ladder() internal returns (uint256 low, uint256 mid, uint256 high, TrozuVault vMid, TrozuVault vHigh) {
        // the standard position from setUp is also in the list (136%)
        (low,) = _open(alice, 2000e18, 0.044e18); // 120%
        (mid, vMid) = _open(bob, 2000e18, 0.073e18); // 199%
        (high, vHigh) = _open(carol, 2000e18, 0.11e18); // 300%
    }

    function _defensePolicy(uint16 walk, uint256 bufferFloor) internal pure returns (TrozuVault.Policy memory p) {
        p = _policy();
        p.targetIcr = 4e18; // defense lifts the ratio, so the target is also the ceiling
        p.bufferFloorMusd = bufferFloor;
        p.maxWalkSteps = walk;
        p.keeperTipBtc = 0;
    }

    function test_defenseTopsUpWhenACompleteWalkProvesALowBuffer() public {
        (, uint256 mid,, TrozuVault vMid,) = _ladder();
        vm.deal(bob, 5 ether);
        vm.startPrank(bob);
        vMid.fundReserveBtc{value: 0.5e18}();
        vMid.setPolicy(_defensePolicy(10, 50_000e18));
        vm.stopPrank();

        uint256 nicrBefore = troveManager.getNominalICR(address(vMid));
        assertEq(uint8(vMid.preview().kind), uint8(TrozuVault.Kind.DefendBtc));
        vm.prank(keeper);
        (TrozuVault.Kind k, uint256 amount,) = vMid.execute(address(0), address(0));

        assertEq(uint8(k), uint8(TrozuVault.Kind.DefendBtc));
        assertGt(amount, 0);
        assertGt(troveManager.getNominalICR(address(vMid)), nicrBefore, "NICR went up");
        assertEq(lens.positionInfo(mid).coll, 0.073e18 + amount);
        assertEq(address(vMid).balance, vMid.reserveBtc());
    }

    function test_defenseDoesNotActWhenTheBufferIsLargeEnough() public {
        (,,, TrozuVault vMid,) = _ladder();
        vm.deal(bob, 5 ether);
        vm.startPrank(bob);
        vMid.fundReserveBtc{value: 0.5e18}();
        vMid.setPolicy(_defensePolicy(10, 500e18)); // buffer is about 2000, above 500
        vm.stopPrank();
        assertEq(uint8(vMid.preview().reason), uint8(TrozuVault.Reason.Healthy));
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.NothingToDo.selector, TrozuVault.Reason.Healthy));
        vm.prank(keeper);
        vMid.execute(address(0), address(0));
    }

    function test_defenseNeverActsOnAnUnknownVerdict() public {
        (,,,, TrozuVault vHigh) = _ladder();
        vm.deal(carol, 5 ether);
        vm.startPrank(carol);
        vHigh.fundReserveBtc{value: 0.5e18}();
        // three troves are ahead of the position, a walk of one step cannot finish
        vHigh.setPolicy(_defensePolicy(1, 1_000_000e18));
        vm.stopPrank();
        assertEq(uint8(vHigh.preview().reason), uint8(TrozuVault.Reason.BufferUnknown));
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.NothingToDo.selector, TrozuVault.Reason.BufferUnknown));
        vm.prank(keeper);
        vHigh.execute(address(0), address(0));
        assertEq(vHigh.reserveBtc(), 0.5e18, "nothing moved");

        // with room to finish the walk it does act
        vm.prank(carol);
        vHigh.setPolicy(_defensePolicy(10, 1_000_000e18));
        assertEq(uint8(vHigh.preview().kind), uint8(TrozuVault.Kind.DefendBtc));
    }

    function test_defenseIsOffWithoutABufferFloor() public {
        (,,, TrozuVault vMid,) = _ladder();
        vm.deal(bob, 5 ether);
        vm.startPrank(bob);
        vMid.fundReserveBtc{value: 0.5e18}();
        vMid.setPolicy(_defensePolicy(10, 0));
        vm.stopPrank();
        assertEq(uint8(vMid.preview().reason), uint8(TrozuVault.Reason.Healthy));
    }

    function test_defenseRespectsTheCaps() public {
        (,,, TrozuVault vMid,) = _ladder();
        TrozuVault.Policy memory p = _defensePolicy(10, 50_000e18);
        p.maxActionBtc = 0.003e18;
        p.periodCapBtc = 0.005e18;
        vm.deal(bob, 5 ether);
        vm.startPrank(bob);
        vMid.fundReserveBtc{value: 0.5e18}();
        vMid.setPolicy(p);
        vm.stopPrank();
        vm.prank(keeper);
        (, uint256 a1,) = vMid.execute(address(0), address(0));
        assertEq(a1, 0.003e18);
        vm.prank(keeper);
        (, uint256 a2,) = vMid.execute(address(0), address(0));
        assertEq(a2, 0.002e18, "only what the period allowed");
        vm.expectRevert();
        vm.prank(keeper);
        vMid.execute(address(0), address(0));
    }

    // ---- never refinances, never borrows ----

    function test_guardianNeverRefinances() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setGlobalRate(10); // a big drop, refinance would be attractive
        setPrice(50_000);
        _execute();
        assertEq(troveManager.getTroveInterestRate(address(vault)), 100, "locked rate untouched");
    }

    // ---- reserve ----

    function test_reserveIsWithdrawableAtAnyTimeEvenWithALivePolicy() public {
        _fundBtc(0.2e18);
        _fundMusdReserve(300e18);
        _setPolicy(_policy());
        setPrice(50_000); // guardian would act right now
        uint256 b = holder.balance;
        vm.startPrank(holder);
        vault.withdrawReserveBtc(0.2e18);
        vault.withdrawReserveMusd(300e18);
        vm.stopPrank();
        assertEq(holder.balance - b, 0.2e18);
        _expectNothing(TrozuVault.Reason.NoReserve);
    }

    function test_cannotWithdrawMoreThanTheReserve() public {
        _fundBtc(0.1e18);
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.ReserveTooSmall.selector, 0.1e18 + 1, 0.1e18));
        vm.prank(holder);
        vault.withdrawReserveBtc(0.1e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(TrozuVault.ReserveTooSmall.selector, 1, 0));
        vm.prank(holder);
        vault.withdrawReserveMusd(1);
    }

    function test_sweepNeverTakesTheReserve() public {
        _fundBtc(0.2e18);
        _fundMusdReserve(300e18);
        // forced BTC and a stray MUSD transfer land outside the ledger
        vm.deal(address(vault), address(vault).balance + 1 ether);
        _fundMusd(address(vault), 50e18);

        uint256 b = holder.balance;
        vm.prank(holder);
        vault.sweep(address(0));
        assertEq(holder.balance - b, 1 ether, "only the forced BTC");
        assertEq(vault.reserveBtc(), 0.2e18);
        assertEq(address(vault).balance, 0.2e18);

        uint256 m0 = musd.balanceOf(holder);
        vm.prank(holder);
        vault.sweep(address(musd));
        assertEq(musd.balanceOf(holder) - m0, 50e18, "only the stray MUSD");
        assertEq(vault.reserveMusd(), 300e18);
        assertEq(musd.balanceOf(address(vault)), 300e18);
    }

    function test_wave1FlowsDoNotTouchTheReserve() public {
        _fundBtc(0.2e18);
        _fundMusdReserve(300e18);
        vm.startPrank(holder);
        vault.addCollateral{value: 0.01e18}(address(0), address(0));
        vault.withdrawCollateral(0.005e18, address(0), address(0));
        vault.borrow(100e18, address(0), address(0), 10e18);
        vm.stopPrank();
        assertEq(vault.reserveBtc(), 0.2e18);
        assertEq(vault.reserveMusd(), 300e18);
        assertEq(address(vault).balance, 0.2e18);
        assertEq(musd.balanceOf(address(vault)), 300e18);
    }

    function test_fundReserveWithPermit() public {
        _fundMusd(holder, 200e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                holder,
                address(vault),
                200e18,
                musd.nonces(holder),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(holderKey, keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(holder);
        vault.fundReserveMusdWithPermit(200e18, deadline, v, r, s);
        assertEq(vault.reserveMusd(), 200e18);
    }

    function test_closedTroveStopsTheGuardian() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        _fundMusd(holder, 3000e18);
        vm.startPrank(holder);
        musd.approve(address(vault), type(uint256).max);
        vault.close();
        vm.stopPrank();
        setPrice(50_000);
        _expectNothing(TrozuVault.Reason.TroveInactive);
    }

    function test_oracleFailureMeansNoAction() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setPrice(50_000);
        // a zero price is what PriceFeed would revert on, so use a broken aggregator answer
        aggregator.setPrice(0);
        vm.expectRevert(); // either NoPrice or the feed refusing, never an action
        vm.prank(keeper);
        vault.execute(address(0), address(0));
        assertEq(vault.reserveBtc(), 0.2e18);
    }

    // ---- keeper hostility ----

    function test_keeperCannotReenterThroughTheTip() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setPrice(50_000);
        HostileKeeper hk = new HostileKeeper(vault);
        vm.prank(address(hk));
        hk.run();
        assertTrue(hk.triedReenter(), "the keeper did try");
        assertFalse(hk.reenterSucceeded(), "and failed");
        // exactly one action's worth left the reserve
        assertEq(vault.spentBtc(), 0.2e18 - vault.reserveBtc());
        assertLt(vault.spentBtc(), 0.05e18 + 1e13 + 1);
    }

    function test_keeperThatRefusesTheTipMakesTheCallRevertAndNothingMoves() public {
        _fundBtc(0.2e18);
        _setPolicy(_policy());
        setPrice(50_000);
        RefusingKeeper rk = new RefusingKeeper(vault);
        vm.expectRevert(TrozuVault.BtcTransferFailed.selector);
        rk.run();
        assertEq(vault.reserveBtc(), 0.2e18);
        assertEq(vault.spentBtc(), 0);
    }

    // ---- debt cap (Phase D lever, tested now) ----

    function test_debtCapAppliesToOpenBorrowAndAdjust() public {
        TrozuFactory capped = new TrozuFactory(core(), 2300e18);
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        // 2000 + fee + gas = 2202, under the cap
        (uint256 cid, address cv) = capped.openPosition{value: 0.05e18}(2000e18, address(0), address(0), 20e18);
        TrozuVault v = TrozuVault(payable(cv));
        cid;

        vm.prank(alice);
        vm.expectRevert(); // 2202 + 200 + fee is over 2300
        v.borrow(200e18, address(0), address(0), 20e18);

        vm.prank(alice);
        v.borrow(50e18, address(0), address(0), 20e18); // 2252 + 0.05 fee still under

        vm.prank(alice);
        vm.expectRevert();
        capped.openPosition{value: 0.2e18}(2200e18, address(0), address(0), 30e18); // 2200 + 2.2 + 200 > 2300

        // repaying or adding collateral is never blocked by the cap
        _fundMusd(alice, 100e18);
        vm.startPrank(alice);
        capped.nft().setApprovalForAll(address(this), false);
        musd.approve(address(v), type(uint256).max);
        v.repay(50e18, address(0), address(0));
        v.addCollateral{value: 0.01e18}(address(0), address(0));
        vm.stopPrank();
        assertEq(v.DEBT_CAP(), 2300e18);
        assertEq(capped.debtCap(), 2300e18);
    }

    // ---- fuzz ----

    /// Whatever the policy and the price, one execute stays inside every bound.
    function testFuzz_executeStaysInsidePolicy(
        uint256 price,
        uint256 floorSeed,
        uint256 targetSeed,
        uint256 actionSeed,
        uint256 capSeed,
        uint256 tipSeed,
        uint256 reserveSeed
    ) public {
        price = bound(price, 20_000, 90_000);
        TrozuVault.Policy memory p = _policy();
        p.floorIcr = bound(floorSeed, 1.11e18, 2e18);
        p.targetIcr = bound(targetSeed, p.floorIcr + 1, 5e18);
        p.maxActionBtc = bound(actionSeed, 1e12, 0.1e18);
        p.periodCapBtc = bound(capSeed, p.maxActionBtc, 0.3e18);
        p.keeperTipBtc = bound(tipSeed, 0, p.periodCapBtc > 1 ? _min(vault.MAX_KEEPER_TIP(), p.periodCapBtc - 1) : 0);
        p.maxActionMusd = 300e18;
        p.periodCapMusd = 600e18;
        uint256 reserve = bound(reserveSeed, 0, 0.5e18);

        if (reserve > 0) _fundBtc(reserve);
        _fundMusdReserve(400e18);
        _setPolicy(p);
        setPrice(price);

        uint256 keeperBefore = keeper.balance;
        uint256 collBefore = _collOf(address(vault));
        uint256 debtBefore = _debtOf(address(vault));
        TrozuVault.Plan memory plan = vault.preview();

        vm.prank(keeper);
        try vault.execute(address(0), address(0)) returns (TrozuVault.Kind k, uint256 amount, uint256 tip) {
            // acts only when it said it would
            assertEq(uint8(k), uint8(plan.kind));
            assertEq(amount, plan.amount);
            assertEq(tip, plan.tip);
            // and only below the floor, since there is no defense configured
            assertLt(plan.icr, p.floorIcr);
            // the keeper takes at most the tip, which is under the cap
            assertEq(keeper.balance - keeperBefore, tip);
            assertLe(tip, vault.MAX_KEEPER_TIP());
            assertLe(tip, p.keeperTipBtc);
            // per action and per period
            if (k == TrozuVault.Kind.RepayMusd) {
                assertLe(amount, p.maxActionMusd);
                assertLe(vault.spentMusd(), p.periodCapMusd);
                assertEq(_debtOf(address(vault)), debtBefore - amount);
            } else {
                assertLe(amount, p.maxActionBtc);
                assertEq(_collOf(address(vault)), collBefore + amount);
            }
            assertLe(vault.spentBtc(), p.periodCapBtc);
            assertLe(vault.spentBtc(), amount + tip + 0);
            // the reserve is backed by real balance
            assertEq(address(vault).balance, vault.reserveBtc());
            assertEq(musd.balanceOf(address(vault)), vault.reserveMusd());
        } catch (bytes memory err) {
            // a refusal moves nothing
            assertEq(plan.kind == TrozuVault.Kind.None, true, "reverted although the plan said act");
            assertEq(bytes4(err), TrozuVault.NothingToDo.selector);
            assertEq(keeper.balance, keeperBefore);
            assertEq(_collOf(address(vault)), collBefore);
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract HostileKeeper {
    TrozuVault internal vault;
    bool public triedReenter;
    bool public reenterSucceeded;

    constructor(TrozuVault v) {
        vault = v;
    }

    function run() external {
        vault.execute(address(0), address(0));
    }

    receive() external payable {
        triedReenter = true;
        try vault.execute(address(0), address(0)) {
            reenterSucceeded = true;
        } catch {}
    }
}

contract RefusingKeeper {
    TrozuVault internal vault;

    constructor(TrozuVault v) {
        vault = v;
    }

    function run() external {
        vault.execute(address(0), address(0));
    }

    receive() external payable {
        revert("no tips");
    }
}
