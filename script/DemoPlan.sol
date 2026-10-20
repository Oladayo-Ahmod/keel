// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {PositionFactory} from "../src/PositionFactory.sol";
import {MezoCore} from "../src/MezoCore.sol";
import {MatsnetCore} from "./MatsnetCore.sol";

interface IHintHelpers {
    function getApproxHint(uint256 cr, uint256 numTrials, uint256 seed)
        external
        view
        returns (address hint, uint256 diff, uint256 latestSeed);
}

interface ISortedTrovesPos {
    function findInsertPosition(uint256 nicr, address prev, address next) external view returns (address, address);
}

/// Opens the two demo positions from one wallet. The second one borrows a little
/// more, so its MUSD covers closing the first.
///
///   export DEPLOYER_PRIVATE_KEY=0x...
///   export FACTORY=0x...
///   export BTC_PRICE_E18=$(cast call <PriceFeed> 'fetchPrice()(uint256)' --rpc-url matsnet | cut -d' ' -f1)
///   forge script script/OpenDemo.s.sol --rpc-url matsnet --broadcast --skip-simulation
///
/// Optional: TARGET_ICR_E18 (default 1.6e18, never below 1.5e18) and RESERVE (default 0.015 BTC
/// that stays in the wallet for gas and a second demo wallet).
contract OpenDemo is Script {
    address internal constant HINT_HELPERS = 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6;

    uint256 internal constant DEBT_1 = 1800e18;
    uint256 internal constant DEBT_2 = 1900e18;
    uint256 internal constant MIN_ICR = 1.5e18;
    uint256 internal constant GAS_COMPENSATION = 200e18;
    // borrowing fee on matsnet is 0.1%
    uint256 internal constant FEE_BPS = 10;

    function run() external {
        require(block.chainid == MatsnetCore.CHAIN_ID, "not matsnet");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        PositionFactory factory = PositionFactory(vm.envAddress("FACTORY"));

        (uint256 coll1, uint256 coll2) = plan(
            vm.envUint("BTC_PRICE_E18"),
            vm.envOr("TARGET_ICR_E18", uint256(1.6e18)),
            vm.addr(key).balance,
            vm.envOr("RESERVE", uint256(0.015e18))
        );
        console2.log("collateral 1", coll1);
        console2.log("collateral 2", coll2);

        vm.startBroadcast(key);
        _open(factory, DEBT_1, coll1);
        _open(factory, DEBT_2, coll2);
        vm.stopBroadcast();
    }

    /// Collateral for each position. Reverts rather than go under 150% or over budget.
    function plan(uint256 price, uint256 targetIcr, uint256 balance, uint256 reserve)
        public
        pure
        returns (uint256 coll1, uint256 coll2)
    {
        require(price > 0, "no price");
        require(targetIcr >= MIN_ICR, "target ICR below 150%");
        coll1 = _collFor(DEBT_1, targetIcr, price);
        coll2 = _collFor(DEBT_2, targetIcr, price);
        require(coll1 + coll2 + reserve <= balance, "not enough BTC for both positions and the reserve");
    }

    function _collFor(uint256 debt, uint256 icr, uint256 price) internal pure returns (uint256) {
        uint256 composite = debt + debt * FEE_BPS / 10_000 + GAS_COMPENSATION;
        // round up so the position is never below the target
        return (composite * icr + price - 1) / price;
    }

    function _open(PositionFactory factory, uint256 debt, uint256 coll) internal {
        (address up, address low) = _hints(debt, coll);
        (uint256 id, address vault) = factory.openPosition{value: coll}(debt, up, low, debt / 100);
        console2.log("position", id);
        console2.log("vault", vault);
    }

    // the NICR to look for is the one after the open: coll * 1e20 / composite debt
    function _hints(uint256 debt, uint256 coll) internal view returns (address, address) {
        uint256 nicr = coll * 1e20 / (debt + debt * FEE_BPS / 10_000 + GAS_COMPENSATION);
        (address hint,,) = IHintHelpers(HINT_HELPERS).getApproxHint(nicr, 50, 42);
        return ISortedTrovesPos(MatsnetCore.get().sortedTroves).findInsertPosition(nicr, hint, hint);
    }
}
