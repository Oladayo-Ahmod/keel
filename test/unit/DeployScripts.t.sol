// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFixture} from "../helpers/MezoFixture.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DemoPlan} from "../../script/DemoPlan.sol";
import {PositionFactory} from "../../src/PositionFactory.sol";
import {PositionLens} from "../../src/PositionLens.sol";

contract DeployScriptsTest is MezoFixture {
    function setUp() public {
        deployMezo(60_000, 100);
        openBackgroundTrove(makeAddr("bg"), 2000e18, 0.12e18);
    }

    function test_deployWiresFactoryAndLensToTheCore() public {
        Deploy script = new Deploy();
        (PositionFactory factory, PositionLens lens) = script.deploy(core());

        assertEq(address(lens.NFT()), address(factory.nft()));
        assertEq(address(factory.implementation().BORROWER_OPERATIONS()), address(borrowerOperations));
        assertEq(address(lens.PRICE_FEED()), address(priceFeed));

        address who = makeAddr("who");
        vm.deal(who, 1e18);
        vm.prank(who);
        (uint256 id,) = factory.openPosition{value: 0.05e18}(2000e18, address(0), address(0), 2e18);
        assertEq(lens.positionInfo(id).holder, who);
    }

    // numbers from the testnet budget: 0.099 BTC, price about 84,127 USD
    function test_planFitsTheTestnetBudget() public {
        DemoPlan demo = new DemoPlan();
        (uint256 c1, uint256 c2) = demo.plan(84_127.77e18, 1.6e18, 0.099e18, 0.015e18);
        assertApproxEqAbs(c1, 0.038073e18, 0.00001e18);
        assertApproxEqAbs(c2, 0.039976e18, 0.00001e18);
        assertLe(c1 + c2 + 0.015e18, 0.099e18);
    }

    function testFuzz_planNeverGoesUnderOneFiftyPercent(uint256 price, uint256 icr) public {
        DemoPlan demo = new DemoPlan();
        price = bound(price, 10_000e18, 500_000e18);
        icr = bound(icr, 1.5e18, 3e18);
        (uint256 c1, uint256 c2) = demo.plan(price, icr, 100e18, 0);
        // ICR = coll * price / composite debt
        assertGe(c1 * price / (1800e18 + 1.8e18 + 200e18), icr);
        assertGe(c2 * price / (1900e18 + 1.9e18 + 200e18), icr);
    }

    function test_planRefusesBelowFloor() public {
        DemoPlan demo = new DemoPlan();
        vm.expectRevert(bytes("target ICR below 150%"));
        demo.plan(84_127e18, 1.49e18, 1e18, 0);
    }

    function test_planRefusesOverBudget() public {
        DemoPlan demo = new DemoPlan();
        vm.expectRevert(bytes("not enough BTC for both positions and the reserve"));
        demo.plan(84_127e18, 1.6e18, 0.09e18, 0.015e18);
    }

    function test_planRefusesNoPrice() public {
        DemoPlan demo = new DemoPlan();
        vm.expectRevert(bytes("no price"));
        demo.plan(0, 1.6e18, 1e18, 0);
    }
}
