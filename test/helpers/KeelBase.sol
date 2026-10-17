// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MezoFixture} from "./MezoFixture.sol";
import {PositionFactory} from "../../src/PositionFactory.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {PositionLens} from "../../src/PositionLens.sol";

/// KEEL on top of the local MUSD deployment, with a little background liquidity
/// so troves can be closed (Mezo refuses to close the last one).
abstract contract KeelBase is MezoFixture {
    PositionFactory internal factory;
    PositionNFT internal nft;
    PositionLens internal lens;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal bg1 = makeAddr("bg1");
    address internal bg2 = makeAddr("bg2");

    uint256 internal constant PRICE = 60_000;
    uint16 internal constant START_RATE = 100;

    function setUp() public virtual {
        deployMezo(PRICE, START_RATE);
        factory = new PositionFactory(core());
        nft = factory.nft();
        lens = new PositionLens(address(nft), core());

        // high ICR, so they sit at the safe end of the list
        openBackgroundTrove(bg1, 2000e18, 0.12e18);
        openBackgroundTrove(bg2, 2000e18, 0.12e18);
    }

    function _open(address who, uint256 debt, uint256 coll) internal returns (uint256 id, PositionVault vault) {
        vm.deal(who, who.balance + coll);
        vm.prank(who);
        (uint256 tokenId, address v) = factory.openPosition{value: coll}(debt, address(0), address(0), debt / 100);
        return (tokenId, PositionVault(payable(v)));
    }

    /// A standard position: 2000 MUSD out, 0.05 BTC in, about 136% at 60k.
    function _openStandard(address who) internal returns (uint256 id, PositionVault vault) {
        return _open(who, 2000e18, 0.05e18);
    }

    function _debtOf(address vault) internal view returns (uint256) {
        (, uint256 p, uint256 i,,,) = troveManager.getEntireDebtAndColl(vault);
        return p + i;
    }

    function _collOf(address vault) internal view returns (uint256 c) {
        (c,,,,,) = troveManager.getEntireDebtAndColl(vault);
    }

    /// Give `who` MUSD by taking it from a background trove holder.
    function _fundMusd(address who, uint256 amount) internal {
        vm.prank(bg1);
        musd.transfer(who, amount);
    }
}
