// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Robots allocation vault — holds the 44,440,000 STR for Statera Robots
///        until the Robots NFT contract exists (testnet ordering).
/// @notice It can release its STR exactly ONCE, all of it, and only to a
///         contract (not a wallet) — the Robots NFT contract, which pays
///         10,000 STR out per mint. Nobody can withdraw it to a wallet.
/// @dev    On mainnet the Robots contract is deployed first and STR mints its
///         allocation straight into it; this vault is only the testnet bridge.
contract RobotsAllocationVault is Ownable2Step {
    using SafeERC20 for IERC20;

    bool public released;
    address public robotsContract;

    event Released(address indexed token, address indexed robotsContract, uint256 amount);

    error AlreadyReleased();
    error NotAContract(address target);
    error NothingToRelease();

    constructor(address owner_) Ownable(owner_) {}

    /// @notice One-time move of the whole STR balance into the Robots contract.
    function release(IERC20 token, address robots) external onlyOwner {
        if (released) revert AlreadyReleased();
        if (robots.code.length == 0) revert NotAContract(robots);
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToRelease();
        released = true;
        robotsContract = robots;
        token.safeTransfer(robots, amount);
        emit Released(address(token), robots, amount);
    }
}
