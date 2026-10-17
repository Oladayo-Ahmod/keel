// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {PositionFactory} from "../src/PositionFactory.sol";
import {PositionLens} from "../src/PositionLens.sol";
import {MezoCore} from "../src/MezoCore.sol";
import {MatsnetCore} from "./MatsnetCore.sol";

/// Deploys the factory (which creates the NFT and the vault implementation) and the lens.
///
///   export DEPLOYER_PRIVATE_KEY=0x...     # never put this in a file in the repo
///   forge script script/Deploy.s.sol --rpc-url matsnet --broadcast --skip-simulation
///
/// The oracle on matsnet is a chain precompile that forge cannot simulate, so use
/// --skip-simulation for anything that touches the price feed.
contract Deploy is Script {
    function run() external returns (PositionFactory factory, PositionLens lens) {
        require(block.chainid == MatsnetCore.CHAIN_ID, "not matsnet");
        MezoCore memory core = MatsnetCore.get();
        _checkCore(core);

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        console2.log("deployer", vm.addr(key));

        vm.startBroadcast(key);
        (factory, lens) = deploy(core);
        vm.stopBroadcast();

        console2.log("factory", address(factory));
        console2.log("nft", address(factory.nft()));
        console2.log("vault implementation", address(factory.implementation()));
        console2.log("lens", address(lens));
    }

    function deploy(MezoCore memory core) public returns (PositionFactory factory, PositionLens lens) {
        factory = new PositionFactory(core);
        lens = new PositionLens(address(factory.nft()), core);
    }

    // every address must hold code before KEEL is bound to it
    function _checkCore(MezoCore memory c) internal view {
        address[8] memory all = [
            c.borrowerOperations,
            c.troveManager,
            c.sortedTroves,
            c.interestRateManager,
            c.collSurplusPool,
            c.activePool,
            c.priceFeed,
            c.musd
        ];
        for (uint256 i; i < all.length; i++) {
            require(all[i].code.length > 0, "core address has no code");
        }
    }
}
