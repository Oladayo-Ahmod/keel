// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

// Only the parts of the MUSD core that KEEL calls. Signatures checked against
// mezo-org/musd at aa25fd6.

interface IBorrowerOperations {
    function openTrove(uint256 debtAmount, address upperHint, address lowerHint) external payable;
    function addColl(address upperHint, address lowerHint) external payable;
    function withdrawColl(uint256 amount, address upperHint, address lowerHint) external;
    function withdrawMUSD(uint256 amount, address upperHint, address lowerHint) external;
    function repayMUSD(uint256 amount, address upperHint, address lowerHint) external;
    function adjustTrove(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint
    ) external payable;
    function closeTrove() external;
    function refinance(address upperHint, address lowerHint) external;
    function claimCollateral() external;
    function getBorrowingFee(uint256 debt) external view returns (uint256);
    function refinancingFeePercentage() external view returns (uint8);
}

interface ITroveManager {
    enum Status {
        nonExistent,
        active,
        closedByOwner,
        closedByLiquidation,
        closedByRedemption
    }

    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingCollateral,
            uint256 pendingPrincipal,
            uint256 pendingInterest
        );
    function getTroveStatus(address borrower) external view returns (Status);
    function getTroveInterestRate(address borrower) external view returns (uint16);
    function checkRecoveryMode(uint256 price) external view returns (bool);
}

interface ISortedTroves {
    function getSize() external view returns (uint256);
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
    function contains(address id) external view returns (bool);
}

interface IInterestRateManager {
    function interestRate() external view returns (uint16);
}

interface ICollSurplusPool {
    function getCollateral(address account) external view returns (uint256);
}

interface IPriceFeed {
    function fetchPrice() external view returns (uint256);
}

interface IMUSD is IERC20, IERC20Permit {}
