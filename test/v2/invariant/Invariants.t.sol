// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";

import {TrozuBase} from "../TrozuBase.sol";
import {TrozuHandler, HandlerDeps} from "./TrozuHandler.sol";
import {TrozuVault} from "../../../src/v2/TrozuVault.sol";
import {PositionLens} from "../../../src/PositionLens.sol";

/// State-machine fuzz for v2. The handler interleaves holder actions, reserve
/// funding and withdrawal, guardian policies and keeper calls, market listings,
/// cancels and buys, NFT transfers, strangers, redemption, liquidation, price,
/// rate and time on a local deployment of the real MUSD contracts. Invariants
/// run after every step.
///
/// The Wave 1 invariants are kept. I2 ("a vault never keeps funds between
/// calls") becomes "a vault holds exactly its reserve".
contract TrozuInvariantsTest is TrozuBase {
    TrozuHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new TrozuHandler(
            HandlerDeps({
                factory: factory,
                musd: musd,
                bo: borrowerOperations,
                tm: troveManager,
                surplus: collSurplusPool,
                irm: interestRateManager,
                aggregator: aggregator,
                council: council,
                aggregatorOwner: address(this),
                market: market,
                feeRecipient: feeRecipient
            })
        );
        handler.init();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](32);
        selectors[0] = handler.openNew.selector;
        selectors[1] = handler.addCollateral.selector;
        selectors[2] = handler.withdrawCollateral.selector;
        selectors[3] = handler.borrow.selector;
        selectors[4] = handler.repay.selector;
        selectors[5] = handler.adjust.selector;
        selectors[6] = handler.refinance.selector;
        selectors[7] = handler.close.selector;
        selectors[8] = handler.reopen.selector;
        selectors[9] = handler.claimSurplus.selector;
        selectors[10] = handler.approveOperator.selector;
        selectors[11] = handler.transfer.selector;
        selectors[12] = handler.strangerCalls.selector;
        selectors[13] = handler.redeem.selector;
        selectors[14] = handler.movePrice.selector;
        selectors[15] = handler.liquidateAll.selector;
        selectors[16] = handler.setRate.selector;
        selectors[17] = handler.warp.selector;
        selectors[18] = handler.checkHolders.selector;
        selectors[19] = handler.fundReserveBtc.selector;
        selectors[20] = handler.withdrawReserveBtc.selector;
        selectors[21] = handler.fundReserveMusd.selector;
        selectors[22] = handler.withdrawReserveMusd.selector;
        selectors[23] = handler.setPolicy.selector;
        selectors[24] = handler.clearPolicy.selector;
        selectors[25] = handler.executeGuardian.selector;
        selectors[26] = handler.list.selector;
        selectors[27] = handler.cancelListing.selector;
        selectors[28] = handler.cancelAllListings.selector;
        selectors[29] = handler.buy.selector;
        selectors[30] = handler.sellThrough.selector;
        selectors[31] = handler.guardScenario.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ---- Wave 1 invariants ----

    // BTC paid out to holders and keepers never exceeds what went in plus redistribution gains
    function invariant_rollingOutflowWithinCollateral() public view {
        assertLe(handler.ghostOut(), handler.ghostIn() + handler.ghostGains(), "outflow exceeds inflow plus gains");
    }

    // every holder action moves only its own vault's collateral, surplus and reserve, by exactly in minus out
    function invariant_ledgerMovesOnlyByHolderFlows() public view {
        assertEq(handler.ledgerViolations(), 0, "ledger mismatch on a holder action");
    }

    // redemption never adds collateral, liquidation never takes from other vaults, price/rate/time change nothing
    function invariant_externalEventsRespectTheLedger() public view {
        assertEq(handler.externalViolations(), 0, "external event broke the ledger");
    }

    // nobody but the current holder ever succeeds on a holder function
    function invariant_onlyCurrentHolderMovesFunds() public view {
        assertEq(handler.unauthorizedSuccess(), 0, "a non-holder succeeded");
    }

    // the NFT owner is who the handler says it is, and a transfer clears the token approval
    function invariant_permissionsClearedOnTransfer() public {
        handler.checkHolders();
        assertEq(handler.holderMismatch(), 0, "holder mismatch");
        assertEq(handler.approvalViolations(), 0, "approval survived a transfer");
    }

    // the lens agrees with Mezo for every position, whatever happened to it
    function invariant_lensAgreesWithMezo() public view {
        uint256 n = handler.vaultCount();
        uint256 price = priceFeed.fetchPrice();
        for (uint256 i; i < n; i++) {
            PositionLens.Info memory info = lens.positionInfo(handler.idAt(i));
            address v = address(handler.vaultAt(i));
            (uint256 c, uint256 p, uint256 interest,,,) = troveManager.getEntireDebtAndColl(v);
            assertEq(info.coll, c);
            assertEq(info.debt, p + interest);
            if (info.active) assertEq(info.icr, troveManager.getCurrentICR(v, price));
            assertEq(info.holder, handler.expectedHolder(i));
        }
    }

    // ---- I2, updated: a vault holds exactly its reserve ----

    function invariant_vaultsHoldExactlyTheirReserve() public view {
        uint256 n = handler.vaultCount();
        for (uint256 i; i < n; i++) {
            TrozuVault v = handler.vaultAt(i);
            assertEq(address(v).balance, v.reserveBtc(), "btc balance differs from the reserve");
            assertEq(musd.balanceOf(address(v)), v.reserveMusd(), "musd balance differs from the reserve");
        }
    }

    // ---- guardian ----

    // outflow per period within the policy, keeper take within the tip cap, acts only when live and inside bounds
    function invariant_guardianStaysInsideThePolicy() public view {
        assertEq(handler.guardianViolations(), 0, "guardian left its bounds");
        uint256 n = handler.vaultCount();
        for (uint256 i; i < n; i++) {
            TrozuVault v = handler.vaultAt(i);
            TrozuVault.Policy memory p = v.policy();
            if (!p.active) continue;
            assertLe(v.spentBtc(), p.periodCapBtc, "btc outflow over the period cap");
            assertLe(v.spentMusd(), p.periodCapMusd, "musd outflow over the period cap");
        }
    }

    // a policy is live only while the token is with the holder who set it
    function invariant_policyDiesOnTransfer() public {
        handler.checkHolders();
        assertEq(handler.policyLiveMismatch(), 0, "policy liveness differs from the epoch rule");
    }

    // ---- market ----

    // buy is atomic and conserves value; cancelled, sold, expired, not-started, stale-epoch and
    // revoked listings never settle; a refused buy moves nothing
    function invariant_marketIsAtomicAndConserving() public view {
        assertEq(handler.marketViolations(), 0, "market broke a settlement rule");
    }

    function invariant_marketHoldsNothing() public view {
        assertEq(musd.balanceOf(address(market)), 0, "market kept musd");
        assertEq(nft.balanceOf(address(market)), 0, "market kept a position");
        assertEq(address(market).balance, 0, "market kept btc");
    }

    /// The fuzz is only worth something if the interesting paths really succeed in it.
    function test_theHandlerReallyDrivesSalesAndGuardianActions() public {
        handler.sellThrough(0, 1, 2000e18, false, 600);
        handler.sellThrough(1, 2, 3000e18, true, 1800);
        assertGe(handler.marketSales(), 1, "no sale went through");
        handler.guardScenario(2, 3);
        handler.guardScenario(0, 1);
        handler.guardScenario(1, 2);
        assertGe(handler.guardianActions(), 1, "no guardian action went through");
        assertEq(handler.marketViolations(), 0);
        assertEq(handler.guardianViolations(), 0);
    }

    function afterInvariant() public view {
        string[32] memory names = [
            "openNew",
            "addCollateral",
            "withdrawCollateral",
            "borrow",
            "repay",
            "adjust",
            "refinance",
            "close",
            "reopen",
            "claimSurplus",
            "approveOperator",
            "transfer",
            "strangerCalls",
            "redeem",
            "movePrice",
            "liquidateAll",
            "setRate",
            "warp",
            "checkHolders",
            "fundReserveBtc",
            "withdrawReserveBtc",
            "fundReserveMusd",
            "withdrawReserveMusd",
            "setPolicy",
            "clearPolicy",
            "executeGuardian",
            "list",
            "cancelListing",
            "cancelAllListings",
            "buy",
            "sellThrough",
            "guardScenario"
        ];
        for (uint256 i; i < names.length; i++) {
            console2.log(names[i], handler.calls(bytes32(bytes(names[i]))));
        }
        console2.log("guardian actions that succeeded", handler.guardianActions());
        console2.log("market sales that succeeded", handler.marketSales());
    }
}
