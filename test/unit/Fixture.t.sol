// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFixture} from "../helpers/MezoFixture.sol";

/// The local deployment of the real MUSD contracts has to behave like matsnet
/// before anything is built on it.
contract FixtureTest is MezoFixture {
    function setUp() public {
        deployMezo(60_000, 100);
    }

    function test_priceAndRate() public view {
        assertEq(priceFeed.fetchPrice(), 60_000e18);
        assertEq(interestRateManager.interestRate(), 100);
    }

    function test_openTroveAndSortedList() public {
        address alice = makeAddr("alice");
        openBackgroundTrove(alice, 2000e18, 1e18);
        assertEq(sortedTroves.getSize(), 1);
        assertEq(musd.balanceOf(alice), 2000e18);
        // debt = 2000 + 0.1% fee + 200 gas reserve
        assertEq(troveManager.getTroveDebt(alice), 2000e18 + 2e18 + 200e18);
        assertEq(troveManager.getTroveInterestRate(alice), 100);
    }
}
