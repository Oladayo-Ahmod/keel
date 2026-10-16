// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";

interface ISortedTroves {
    function getSize() external view returns (uint256);
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
}

interface ITroveManager {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256);
}

/// Read-only measurement of the redemption buffer walk against live matsnet state.
/// Run: forge test --match-contract BufferGas -vv --fork-url matsnet --fork-block-number <n>
contract BufferGas is Test {
    ISortedTroves constant SORTED = ISortedTroves(0x722E4D24FD6Ff8b0AC679450F3D91294607268fA);
    ITroveManager constant TROVES = ITroveManager(0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0);

    // PriceFeed reads a chain precompile that forge's EVM does not implement, so use a fixed price.
    uint256 constant PRICE = 84_127.77e18;
    uint256 constant MCR = 1.1e18;
    uint256 constant GAS_COMP = 200e18;

    /// Walk using getCurrentICR plus getEntireDebtAndColl, the straightforward version.
    function _walkTwoCalls(uint256 price, uint256 maxSteps)
        internal
        view
        returns (uint256 steps, uint256 eligible, uint256 buffer, uint256 minLot)
    {
        minLot = type(uint256).max;
        address cur = SORTED.getLast();
        while (cur != address(0) && steps < maxSteps) {
            steps++;
            if (TROVES.getCurrentICR(cur, price) >= MCR) {
                (, uint256 p, uint256 i,,,) = TROVES.getEntireDebtAndColl(cur);
                uint256 lot = p + i - GAS_COMP;
                buffer += lot;
                eligible++;
                if (lot < minLot) minLot = lot;
            }
            cur = SORTED.getPrev(cur);
        }
    }

    /// Walk using only getEntireDebtAndColl and computing ICR locally.
    function _walkOneCall(uint256 price, uint256 maxSteps)
        internal
        view
        returns (uint256 steps, uint256 eligible, uint256 buffer)
    {
        address cur = SORTED.getLast();
        while (cur != address(0) && steps < maxSteps) {
            steps++;
            (uint256 c, uint256 p, uint256 i,,,) = TROVES.getEntireDebtAndColl(cur);
            uint256 debt = p + i;
            if (c * price / debt >= MCR) {
                buffer += debt - GAS_COMP;
                eligible++;
            }
            cur = SORTED.getPrev(cur);
        }
    }

    function test_gasFullWalk() public view {
        uint256 price = PRICE;
        uint256 size = SORTED.getSize();
        console2.log("block", block.number);
        console2.log("troves in list", size);

        uint256 g = gasleft();
        (uint256 steps, uint256 eligible, uint256 buffer, uint256 minLot) = _walkTwoCalls(price, type(uint256).max);
        uint256 twoCalls = g - gasleft();
        console2.log("two-call walk: steps", steps);
        console2.log("two-call walk: eligible", eligible);
        console2.log("two-call walk: total gas", twoCalls);
        console2.log("two-call walk: gas per step", twoCalls / steps);
        console2.log("buffer behind last trove (MUSD, whole)", buffer / 1e18);
        console2.log("smallest eligible lot (MUSD, whole)", minLot / 1e18);

        g = gasleft();
        (steps, eligible,) = _walkOneCall(price, type(uint256).max);
        uint256 oneCall = g - gasleft();
        console2.log("one-call walk: total gas", oneCall);
        console2.log("one-call walk: gas per step", oneCall / steps);
        assertEq(steps, size);
    }

    /// Cost curve for candidate step caps.
    function test_gasByCap() public view {
        uint256 price = PRICE;
        uint256[4] memory caps = [uint256(10), 25, 50, 100];
        for (uint256 k = 0; k < caps.length; k++) {
            uint256 g = gasleft();
            _walkOneCall(price, caps[k]);
            console2.log("cap", caps[k]);
            console2.log("  one-call gas", g - gasleft());
        }
    }
}
