// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MezoCore} from "../src/MezoCore.sol";

/// Mezo testnet (matsnet, chain id 31611) addresses. Source: docs/CHANGELOG.md and
/// solidity/artifacts/deployments/matsnet in mezo-org/musd, checked against the live
/// chain, see docs/VERIFICATION.md.
library MatsnetCore {
    uint256 internal constant CHAIN_ID = 31611;

    function get() internal pure returns (MezoCore memory) {
        return MezoCore({
            borrowerOperations: 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5,
            troveManager: 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0,
            sortedTroves: 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA,
            interestRateManager: 0xD4D6c36A592A2c5e86035A6bca1d57747a567f37,
            collSurplusPool: 0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9,
            activePool: 0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51,
            priceFeed: 0x86bCF0841622a5dAC14A313a15f96A95421b9366,
            musd: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
        });
    }
}
