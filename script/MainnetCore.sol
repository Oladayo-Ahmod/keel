// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoCore} from "../src/MezoCore.sol";

/// Mezo mainnet (chain id 31612) addresses, from
/// lib/musd/solidity/artifacts/deployments/mainnet. Used by the fork tests and by
/// the capped mainnet deployment if it is ever approved. Not used by the testnet
/// scripts.
library MainnetCore {
    uint256 internal constant CHAIN_ID = 31612;

    function get() internal pure returns (MezoCore memory) {
        return MezoCore({
            borrowerOperations: 0x44b1bac67dDA612a41a58AAf779143B181dEe031,
            troveManager: 0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193,
            sortedTroves: 0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f,
            interestRateManager: 0x4a453700d157717Fe02fB62E7700ED7845048285,
            collSurplusPool: 0xBF51807ACb3394B8550f0554FB9098856Ef5F491,
            activePool: 0x3012C2fE1240e3754E5C200A0946bb0E07474876,
            priceFeed: 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88,
            musd: 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
        });
    }
}
