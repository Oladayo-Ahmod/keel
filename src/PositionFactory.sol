// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PositionNFT} from "./PositionNFT.sol";
import {PositionVault} from "./PositionVault.sol";
import {MezoCore} from "./MezoCore.sol";

/// Opens positions: clone a vault, open its trove, then mint the NFT to the
/// opener. No owner, no setters, no upgrade path.
contract PositionFactory is ReentrancyGuard {
    PositionNFT public immutable nft;
    PositionVault public immutable implementation;

    uint256 public totalPositions;

    event PositionCreated(uint256 indexed tokenId, address indexed vault, address indexed holder);

    constructor(MezoCore memory core) {
        nft = new PositionNFT(address(this));
        implementation = new PositionVault(address(this), address(nft), core);
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
        PositionVault(payable(vault)).initializeAndOpen{value: msg.value}(
            id, msg.sender, debt, upperHint, lowerHint, maxFee
        );
        emit PositionCreated(id, vault, msg.sender);
        nft.mint(msg.sender, id, vault);
    }
}
