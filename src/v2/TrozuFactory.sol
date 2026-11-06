// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {TrozuNFT} from "./TrozuNFT.sol";
import {TrozuVault} from "./TrozuVault.sol";
import {PositionLens} from "../PositionLens.sol";
import {MezoCore} from "../MezoCore.sol";

/// Opens positions: clone a vault, open its trove, then mint the NFT to the
/// opener. Creates the NFT, a lens bound to it and the vault implementation.
/// No owner, no setters, no upgrade path.
///
/// `debtCap` is fixed at deployment and applied by every vault it clones to the
/// position's total debt whenever debt is added. Zero means no cap.
contract TrozuFactory is ReentrancyGuard {
    TrozuNFT public immutable nft;
    PositionLens public immutable lens;
    TrozuVault public immutable implementation;
    uint256 public immutable debtCap;

    uint256 public totalPositions;

    event PositionCreated(uint256 indexed tokenId, address indexed vault, address indexed holder);

    constructor(MezoCore memory core, uint256 debtCap_) {
        nft = new TrozuNFT(address(this));
        lens = new PositionLens(address(nft), core);
        implementation = new TrozuVault(address(this), address(nft), address(lens), core, debtCap_);
        debtCap = debtCap_;
    }

    /// msg.value is the collateral. The minted MUSD goes to the caller, who also
    /// receives the NFT. The mint is last so the receiver callback sees a
    /// finished position.
    function openPosition(uint256 debt, address upperHint, address lowerHint, uint256 maxFee)
        external
        payable
        nonReentrant
        returns (uint256 id, address vault)
    {
        id = ++totalPositions;
        vault = Clones.clone(address(implementation));
        TrozuVault(payable(vault)).initializeAndOpen{value: msg.value}(
            id, msg.sender, debt, upperHint, lowerHint, maxFee
        );
        emit PositionCreated(id, vault, msg.sender);
        nft.mint(msg.sender, id, vault);
    }
}
