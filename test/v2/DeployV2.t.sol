// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFixture} from "../helpers/MezoFixture.sol";
import {DeployV2} from "../../script/DeployV2.s.sol";
import {TrozuFactory} from "../../src/v2/TrozuFactory.sol";
import {TrozuMarket} from "../../src/v2/TrozuMarket.sol";

contract DeployV2Test is MezoFixture {
    DeployV2 internal script;

    function setUp() public {
        deployMezo(60_000, 100);
        script = new DeployV2();
    }

    function test_deployWiresTheV2ContractsToTheCoreAndEachOther() public {
        address recipient = makeAddr("recipient");
        (TrozuFactory f, TrozuMarket m) = script.deploy(core(), recipient, 25, 0);
        assertEq(address(f.implementation().NFT()), address(f.nft()));
        assertEq(address(f.lens().NFT()), address(f.nft()));
        assertEq(address(f.implementation().LENS()), address(f.lens()));
        assertEq(address(f.implementation().BORROWER_OPERATIONS()), address(borrowerOperations));
        assertEq(address(m.NFT()), address(f.nft()));
        assertEq(address(m.MUSD()), address(musd));
        assertEq(address(m.TROVE_MANAGER()), address(troveManager));
        assertEq(m.FEE_RECIPIENT(), recipient);
        assertEq(m.FEE_BPS(), 25);
        assertEq(f.debtCap(), 0);
        assertEq(f.implementation().DEBT_CAP(), 0);
        assertEq(f.nft().name(), "Trozu Position");
        assertEq(f.nft().symbol(), "TROZU");
    }

    function test_deployRefusesAFeeOverTheCap() public {
        vm.expectRevert(TrozuMarket.FeeTooHigh.selector);
        script.deploy(core(), makeAddr("r"), 101, 0);
    }

    function test_debtCapReachesTheImplementation() public {
        (TrozuFactory f,) = script.deploy(core(), makeAddr("r"), 25, 5000e18);
        assertEq(f.implementation().DEBT_CAP(), 5000e18);
    }
}
