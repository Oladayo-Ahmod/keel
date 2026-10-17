// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface INftTransfer {
    function transferFrom(address from, address to, uint256 id) external;
}

/// A contract holder that attacks from inside the callbacks it receives: the
/// BTC payout and the ERC-721 receiver hook.
contract Hostile is IERC721Receiver {
    address public target;
    bytes[] internal attacks;
    bool public armed;
    uint256 public attempted;
    uint256 public blocked;

    // optional: move the NFT away from inside the payout callback
    address public nftToken;
    uint256 public nftId;
    address public nftTo;

    function arm(address target_, bytes[] calldata attacks_) external {
        target = target_;
        delete attacks;
        for (uint256 i; i < attacks_.length; i++) {
            attacks.push(attacks_[i]);
        }
        armed = true;
    }

    function armTransfer(address token, uint256 id, address to) external {
        nftToken = token;
        nftId = id;
        nftTo = to;
    }

    function exec(address to, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function approveToken(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        _attack();
        if (nftTo != address(0)) {
            INftTransfer(nftToken).transferFrom(address(this), nftTo, nftId);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            _attack();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    function _attack() internal {
        for (uint256 i; i < attacks.length; i++) {
            (bool ok, bytes memory ret) = target.call(attacks[i]);
            attempted++;
            if (!ok && ret.length >= 4 && bytes4(ret) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector) {
                blocked++;
            }
        }
    }
}
