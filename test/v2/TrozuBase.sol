// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoFixture} from "../helpers/MezoFixture.sol";
import {TrozuFactory} from "../../src/v2/TrozuFactory.sol";
import {TrozuNFT} from "../../src/v2/TrozuNFT.sol";
import {TrozuVault} from "../../src/v2/TrozuVault.sol";
import {TrozuMarket} from "../../src/v2/TrozuMarket.sol";
import {PositionLens} from "../../src/PositionLens.sol";

/// Trozu v2 on top of the local MUSD deployment, with a little background liquidity
/// so troves can be closed (Mezo refuses to close the last one).
abstract contract TrozuBase is MezoFixture {
    TrozuFactory internal factory;
    TrozuNFT internal nft;
    PositionLens internal lens;
    TrozuMarket internal market;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal bg1 = makeAddr("bg1");
    address internal bg2 = makeAddr("bg2");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant PRICE = 60_000;
    uint16 internal constant START_RATE = 100;
    uint16 internal constant FEE_BPS = 25;

    function setUp() public virtual {
        deployMezo(PRICE, START_RATE);
        factory = new TrozuFactory(core(), 0);
        nft = factory.nft();
        lens = factory.lens();
        market = new TrozuMarket(address(nft), address(musd), address(troveManager), feeRecipient, FEE_BPS);

        // high ICR, so they sit at the safe end of the list
        openBackgroundTrove(bg1, 2000e18, 0.12e18);
        openBackgroundTrove(bg2, 2000e18, 0.12e18);
    }

    function _open(address who, uint256 debt, uint256 coll) internal returns (uint256 id, TrozuVault vault) {
        vm.deal(who, who.balance + coll);
        vm.prank(who);
        (uint256 tokenId, address v) = factory.openPosition{value: coll}(debt, address(0), address(0), debt / 100);
        return (tokenId, TrozuVault(payable(v)));
    }

    /// A standard position: 2000 MUSD out, 0.05 BTC in, about 136% at 60k.
    function _openStandard(address who) internal returns (uint256 id, TrozuVault vault) {
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
