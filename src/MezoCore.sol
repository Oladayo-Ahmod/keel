// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Addresses of the Mezo MUSD core that a KEEL deployment is bound to.
struct MezoCore {
    address borrowerOperations;
    address troveManager;
    address sortedTroves;
    address interestRateManager;
    address collSurplusPool;
    address activePool;
    address priceFeed;
    address musd;
}
