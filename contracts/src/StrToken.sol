// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Statera (STR) — the Statera token on Arc, tied into X1.City.
/// @notice Plain, sealed ERC-20 (owner decision 2026-10-16):
///         - 88,880,000 STR minted ONCE in the constructor; no mint function → supply can never grow.
///         - NO owner, NO admin keys, NO transfer tax, NO pause / freeze / blacklist. Nothing anyone can change.
///         - Burnable (burn / burnFrom) with an on-chain `totalBurned` counter; EIP-2612 permit.
///         Any trading tax lives in Statera's own Uniswap V4 hook pool, never in the token.
///         Split: 50% Robots NFTs (10,000 per mint) · 20% game & staking · 20% treasury & liquidity · 10% team.
contract StrToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY        = 88_880_000e18;
    uint256 public constant ROBOTS_ALLOCATION   = 44_440_000e18; // 50%
    uint256 public constant GAME_ALLOCATION     = 17_776_000e18; // 20%
    uint256 public constant TREASURY_ALLOCATION = 17_776_000e18; // 20%
    uint256 public constant TEAM_ALLOCATION     =  8_888_000e18; // 10%

    /// @notice Total STR permanently destroyed by holders. Supply only ever goes down.
    uint256 public totalBurned;

    error ZeroAddress();

    constructor(address robotsVault, address gameRewards, address treasury, address team)
        ERC20("Statera", "STR")
        ERC20Permit("Statera")
    {
        if (robotsVault == address(0) || gameRewards == address(0) || treasury == address(0) || team == address(0)) revert ZeroAddress();
        _mint(robotsVault, ROBOTS_ALLOCATION);
        _mint(gameRewards, GAME_ALLOCATION);
        _mint(treasury, TREASURY_ALLOCATION);
        _mint(team, TEAM_ALLOCATION);
        assert(totalSupply() == TOTAL_SUPPLY);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == address(0)) totalBurned += value;
        super._update(from, to, value);
    }
}
