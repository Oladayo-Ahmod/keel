// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {TrozuFactory} from "../src/v2/TrozuFactory.sol";
import {TrozuMarket} from "../src/v2/TrozuMarket.sol";
import {MezoCore} from "../src/MezoCore.sol";
import {MatsnetCore} from "./MatsnetCore.sol";

/// Wave 2 deployment on Mezo testnet: the factory (which creates the NFT, a lens bound
/// to it and the vault implementation) and the market. The Wave 1 contracts are not touched.
///
///   export DEPLOYER_PRIVATE_KEY=0x...     # never put this in a file in the repo
///   export FEE_RECIPIENT=0x...            # optional, defaults to the deployer
///   export FEE_BPS=25                     # optional, the market refuses more than 100
///   export DEBT_CAP=0                     # optional, per-position debt cap in MUSD wei, 0 = none
///   forge script script/DeployV2.s.sol --rpc-url matsnet --broadcast --skip-simulation
///
/// The oracle on matsnet is a chain precompile that forge cannot simulate, hence
/// --skip-simulation for anything that touches the price feed.
contract DeployV2 is Script {
    function run() external returns (TrozuFactory factory, TrozuMarket market) {
        require(block.chainid == MatsnetCore.CHAIN_ID, "not matsnet");
        MezoCore memory core = MatsnetCore.get();
        _checkCore(core);

        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(25)));
        uint256 debtCap = vm.envOr("DEBT_CAP", uint256(0));
        console2.log("deployer", deployer);
        console2.log("fee recipient", feeRecipient);
        console2.log("fee bps", feeBps);
        console2.log("debt cap", debtCap);

        vm.startBroadcast(key);
        (factory, market) = deploy(core, feeRecipient, feeBps, debtCap);
        vm.stopBroadcast();

        console2.log("factory", address(factory));
        console2.log("nft", address(factory.nft()));
        console2.log("lens", address(factory.lens()));
        console2.log("vault implementation", address(factory.implementation()));
        console2.log("market", address(market));
    }

    function deploy(MezoCore memory core, address feeRecipient, uint16 feeBps, uint256 debtCap)
        public
        returns (TrozuFactory factory, TrozuMarket market)
    {
        factory = new TrozuFactory(core, debtCap);
        market = new TrozuMarket(address(factory.nft()), core.musd, core.troveManager, feeRecipient, feeBps);
    }

    // every address must hold code before Trozu is bound to it
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
