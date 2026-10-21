// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/// Sizing for the two testnet demo positions. The second one borrows a little
/// more, so its MUSD covers closing the first. script/open_demo.sh calls `plan`
/// and sends the transactions; forge script cannot be used for the open itself,
/// because the Mezo price feed is a chain precompile that forge's EVM lacks.
contract DemoPlan {
    uint256 internal constant DEBT_1 = 1800e18;
    uint256 internal constant DEBT_2 = 1900e18;
    uint256 internal constant MIN_ICR = 1.5e18;
    uint256 internal constant GAS_COMPENSATION = 200e18;
    // borrowing fee on matsnet is 0.1%
    uint256 internal constant FEE_BPS = 10;

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
}
