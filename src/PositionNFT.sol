// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/// Ownership token for a KEEL position. Whoever holds it controls the vault.
contract PositionNFT is ERC721Enumerable {
    address public immutable factory;

    /// Vault that backs each token id.
    mapping(uint256 => address) public vaultOf;

    /// Bumped on every transfer, mint included. Anything that must stop applying
    /// after a transfer records the epoch it was created in and compares later.
    mapping(uint256 => uint256) public transferEpoch;

    error OnlyFactory();

    constructor(address factory_) ERC721("KEEL Position", "KEEL") {
        factory = factory_;
    }

    function mint(address to, uint256 id, address vault) external {
        if (msg.sender != factory) revert OnlyFactory();
        vaultOf[id] = vault;
        _safeMint(to, id);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        transferEpoch[tokenId]++;
        return super._update(to, tokenId, auth);
    }
}
