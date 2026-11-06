// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";

import {KeelBase} from "../helpers/KeelBase.sol";
import {KeelHandler, HandlerDeps} from "./KeelHandler.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {PositionLens} from "../../src/PositionLens.sol";

/// State-machine fuzz: the handler interleaves holder actions, NFT transfers,
/// strangers, redemption, liquidation, price, rate and time on a local
/// deployment of the real MUSD contracts. Invariants run after every step.
contract InvariantsTest is KeelBase {
    KeelHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new KeelHandler(
            HandlerDeps({
                factory: factory,
                musd: musd,
                bo: borrowerOperations,
                tm: troveManager,
                surplus: collSurplusPool,
                irm: interestRateManager,
                aggregator: aggregator,
                council: council,
                aggregatorOwner: address(this)
            })
        );
        handler.init();

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](19);
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
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // BTC paid out to holders never exceeds what went in plus redistribution gains
    function invariant_rollingOutflowWithinCollateral() public view {
        assertLe(handler.ghostOut(), handler.ghostIn() + handler.ghostGains(), "outflow exceeds inflow plus gains");
    }

    // every holder action moves only its own vault's collateral-plus-surplus, by exactly in minus out
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

    // a vault never keeps funds between calls
    function invariant_vaultsHoldNothing() public view {
        uint256 n = handler.vaultCount();
        for (uint256 i; i < n; i++) {
            address v = address(handler.vaultAt(i));
            assertEq(v.balance, 0, "idle btc");
            assertEq(musd.balanceOf(v), 0, "idle musd");
        }
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

    function afterInvariant() public view {
        string[19] memory names = [
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
            "checkHolders"
        ];
        for (uint256 i; i < names.length; i++) {
            console2.log(names[i], handler.calls(bytes32(bytes(names[i]))));
        }
    }
}
