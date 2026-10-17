// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MUSD} from "musd/token/MUSD.sol";
import {ActivePool} from "musd/ActivePool.sol";
import {BorrowerOperations} from "musd/BorrowerOperations.sol";
import {BorrowerOperationsSignatures} from "musd/BorrowerOperationsSignatures.sol";
import {CollSurplusPool} from "musd/CollSurplusPool.sol";
import {DefaultPool} from "musd/DefaultPool.sol";
import {GasPool} from "musd/GasPool.sol";
import {GovernableVariables} from "musd/GovernableVariables.sol";
import {HintHelpers} from "musd/HintHelpers.sol";
import {InterestRateManager} from "musd/InterestRateManager.sol";
import {PCV} from "musd/PCV.sol";
import {PriceFeed} from "musd/PriceFeed.sol";
import {SortedTroves} from "musd/SortedTroves.sol";
import {StabilityPool} from "musd/StabilityPool.sol";
import {TroveManager} from "musd/TroveManager.sol";
import {MockAggregator} from "musd/tests/MockAggregator.sol";

import {MezoCore} from "../../src/MezoCore.sol";

/// Deploys the real MUSD contracts (pinned submodule) behind proxies, the same
/// way the Mezo deploy scripts do. The only fake is the oracle: the real
/// PriceFeed reads a MockAggregator.
abstract contract MezoFixture is Test {
    MUSD internal musd;
    ActivePool internal activePool;
    BorrowerOperations internal borrowerOperations;
    BorrowerOperationsSignatures internal signatures;
    CollSurplusPool internal collSurplusPool;
    DefaultPool internal defaultPool;
    GasPool internal gasPool;
    GovernableVariables internal governable;
    HintHelpers internal hintHelpers;
    InterestRateManager internal interestRateManager;
    PCV internal pcv;
    PriceFeed internal priceFeed;
    SortedTroves internal sortedTroves;
    StabilityPool internal stabilityPool;
    TroveManager internal troveManager;
    MockAggregator internal aggregator;

    address internal council = makeAddr("council");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant ORACLE_DECIMALS = 8;
    uint256 internal constant GAS_COMP = 200e18;

    function deployMezo(uint256 btcPriceUsd, uint16 interestRateBps) internal {
        // oracle first, the price feed needs a non-zero answer at setOracle
        aggregator = new MockAggregator(uint8(ORACLE_DECIMALS));
        aggregator.setPrice(btcPriceUsd * 10 ** ORACLE_DECIMALS);

        musd = new MUSD();
        activePool = ActivePool(payable(_proxy(address(new ActivePool()), abi.encodeCall(ActivePool.initialize, ()))));
        borrowerOperations = BorrowerOperations(
            _proxy(address(new BorrowerOperations()), abi.encodeCall(BorrowerOperations.initialize, ()))
        );
        signatures = BorrowerOperationsSignatures(
            _proxy(
                address(new BorrowerOperationsSignatures()), abi.encodeCall(BorrowerOperationsSignatures.initialize, ())
            )
        );
        collSurplusPool = CollSurplusPool(
            payable(_proxy(address(new CollSurplusPool()), abi.encodeCall(CollSurplusPool.initialize, ())))
        );
        defaultPool =
            DefaultPool(payable(_proxy(address(new DefaultPool()), abi.encodeCall(DefaultPool.initialize, ()))));
        gasPool = GasPool(_proxy(address(new GasPool()), abi.encodeCall(GasPool.initialize, ())));
        governable = GovernableVariables(
            _proxy(address(new GovernableVariables()), abi.encodeCall(GovernableVariables.initialize, (0)))
        );
        hintHelpers = HintHelpers(_proxy(address(new HintHelpers()), abi.encodeCall(HintHelpers.initialize, ())));
        interestRateManager = InterestRateManager(
            _proxy(address(new InterestRateManager()), abi.encodeCall(InterestRateManager.initialize, ()))
        );
        pcv = PCV(payable(_proxy(address(new PCV()), abi.encodeCall(PCV.initialize, (0)))));
        priceFeed = PriceFeed(_proxy(address(new PriceFeed()), abi.encodeCall(PriceFeed.initialize, ())));
        sortedTroves = SortedTroves(_proxy(address(new SortedTroves()), abi.encodeCall(SortedTroves.initialize, ())));
        stabilityPool =
            StabilityPool(payable(_proxy(address(new StabilityPool()), abi.encodeCall(StabilityPool.initialize, ()))));
        troveManager = TroveManager(_proxy(address(new TroveManager()), abi.encodeCall(TroveManager.initialize, ())));

        musd.initialize(
            address(troveManager), address(stabilityPool), address(borrowerOperations), address(interestRateManager)
        );
        priceFeed.setOracle(address(aggregator));

        signatures.setAddresses(
            address(activePool),
            address(borrowerOperations),
            address(collSurplusPool),
            address(defaultPool),
            address(interestRateManager),
            address(stabilityPool)
        );
        interestRateManager.setAddresses(
            address(activePool), address(borrowerOperations), address(musd), address(pcv), address(troveManager)
        );
        stabilityPool.setAddresses(
            address(activePool),
            address(borrowerOperations),
            address(musd),
            address(priceFeed),
            address(sortedTroves),
            address(troveManager)
        );
        hintHelpers.setAddresses(address(borrowerOperations), address(sortedTroves), address(troveManager));
        pcv.setAddresses(address(borrowerOperations), address(musd));
        defaultPool.setAddresses(address(activePool), address(troveManager));
        activePool.setAddresses(
            address(borrowerOperations),
            address(collSurplusPool),
            address(defaultPool),
            address(interestRateManager),
            address(stabilityPool),
            address(troveManager)
        );
        address[13] memory boAddresses = [
            address(activePool),
            address(signatures),
            address(collSurplusPool),
            address(defaultPool),
            address(gasPool),
            address(governable),
            address(interestRateManager),
            address(musd),
            address(pcv),
            address(priceFeed),
            address(sortedTroves),
            address(stabilityPool),
            address(troveManager)
        ];
        borrowerOperations.setAddresses(boAddresses);
        collSurplusPool.setAddresses(address(activePool), address(borrowerOperations), address(troveManager));
        troveManager.setAddresses(
            address(activePool),
            address(borrowerOperations),
            address(collSurplusPool),
            address(defaultPool),
            address(gasPool),
            address(interestRateManager),
            address(musd),
            address(pcv),
            address(priceFeed),
            address(sortedTroves),
            address(stabilityPool)
        );
        gasPool.setAddresses(address(musd), address(troveManager));
        sortedTroves.setParams(type(uint256).max, address(borrowerOperations), address(troveManager));

        // governance: a council that can set the global interest rate
        pcv.startChangingRoles(council, treasury);
        pcv.finalizeChangingRoles();
        setGlobalRate(interestRateBps);
    }

    function core() internal view returns (MezoCore memory) {
        return MezoCore({
            borrowerOperations: address(borrowerOperations),
            troveManager: address(troveManager),
            sortedTroves: address(sortedTroves),
            interestRateManager: address(interestRateManager),
            collSurplusPool: address(collSurplusPool),
            activePool: address(activePool),
            priceFeed: address(priceFeed),
            musd: address(musd)
        });
    }

    /// Goes through the real propose/approve flow, including the 7 day delay.
    function setGlobalRate(uint16 bps) internal {
        vm.startPrank(council);
        interestRateManager.proposeInterestRate(bps);
        vm.warp(block.timestamp + 7 days);
        interestRateManager.approveInterestRate();
        vm.stopPrank();
    }

    function setPrice(uint256 btcPriceUsd) internal {
        aggregator.setPrice(btcPriceUsd * 10 ** ORACLE_DECIMALS);
    }

    /// Opens a plain EOA trove, used as background liquidity in the list.
    function openBackgroundTrove(address who, uint256 debt, uint256 collateral) internal {
        vm.deal(who, who.balance + collateral);
        vm.prank(who);
        borrowerOperations.openTrove{value: collateral}(debt, address(0), address(0));
    }

    function _proxy(address impl, bytes memory init) private returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }
}
