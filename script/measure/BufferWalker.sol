// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISortedTroves {
    function getSize() external view returns (uint256);
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
}

interface ITroveManager {
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256);
}

/// Measures the redemption buffer walk against live matsnet state without a local fork.
/// The constructor does the walk and returns the result as creation output, so the node runs
/// it server side:
///   cast call --create $(forge inspect BufferWalker bytecode)$(cast abi-encode "x(uint256,uint256)" CAP PRICE)
///   cast estimate --create <same bytecode and args>
/// The oracle is a chain precompile forge cannot run, so the price is an argument.
contract BufferWalker {
    ISortedTroves constant SORTED = ISortedTroves(0x722E4D24FD6Ff8b0AC679450F3D91294607268fA);
    ITroveManager constant TROVES = ITroveManager(0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0);
    uint256 constant MCR = 1.1e18;
    uint256 constant GAS_COMP = 200e18;

    constructor(uint256 maxSteps, uint256 price) {
        uint256 steps;
        uint256 eligible;
        uint256 buffer;
        uint256 minLot = type(uint256).max;
        address cur = SORTED.getLast();
        while (cur != address(0) && steps < maxSteps) {
            steps++;
            (uint256 c, uint256 p, uint256 i,,,) = TROVES.getEntireDebtAndColl(cur);
            uint256 debt = p + i;
            if (c * price / debt >= MCR) {
                uint256 lot = debt - GAS_COMP;
                buffer += lot;
                eligible++;
                if (lot < minLot) minLot = lot;
            }
            cur = SORTED.getPrev(cur);
        }
        bytes memory out = abi.encode(steps, eligible, buffer, minLot, SORTED.getSize());
        assembly {
            return(add(out, 0x20), mload(out))
        }
    }
}
