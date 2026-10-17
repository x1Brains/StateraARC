// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StrToken} from "../src/StrToken.sol";
import {RobotsAllocationVault} from "../src/RobotsAllocationVault.sol";
import {StateraRobots} from "../src/StateraRobots.sol";

/// Arc MAINNET (owner decisions 2026-10-16):
///   deployer/owner (DEPLOYER_PK)  = 0x125c2aB36e45A161ADb8BFed417f514563DFBAa9 → owns STR + Robots, holds the 20% GAME allocation
///   TREASURY                      = 0x731CE24A5b475006A466B9B3Bf69707999b328DF → 20% treasury STR + Robots mint USDC + 5% royalty
///   TEAM 0x2862…35ad5 (owner's)   → receives the 10% team STR DIRECTLY (owner 10-16: no vesting contract; lock later, e.g. Argus locker)
///   50% → Robots contract (10,000 STR per mint). STR has NO tax and NO owner (any trade tax = our V4 hook pool, later).
contract DeployMainnet is Script {
    address constant USDC     = 0x3600000000000000000000000000000000000000;
    address constant TREASURY = 0x731CE24A5b475006A466B9B3Bf69707999b328DF;
    address constant TEAM     = 0x286262070270a2E8FCbD1984d143837f05635ad5;   // owner 10-16: team 10% sent directly (no vesting)
    StrToken public str; StateraRobots public robots;
    string  constant BASE_URI = "https://arweave.net/4qP1Yfo1WVj3YWJG-NEDh7RN0ZHmcWtiomF8J4tfoVI/";

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address d = vm.addr(pk);
        vm.startBroadcast(pk);
        RobotsAllocationVault vault = new RobotsAllocationVault(d);
        //                  robotsVault      game  treasury  team
        str = new StrToken(address(vault), d,    TREASURY, TEAM);              // owner 10-16: plain, ownerless, NO tax
        robots = new StateraRobots(d, IERC20(USDC), IERC20(address(str)), TREASURY, BASE_URI);
        vault.release(IERC20(address(str)), address(robots));
        vm.stopBroadcast();
        require(str.balanceOf(address(robots)) == 44_440_000e18, "robots alloc");
        require(str.balanceOf(TREASURY) == 17_776_000e18 && str.balanceOf(d) == 17_776_000e18 && str.balanceOf(TEAM) == 8_888_000e18, "alloc");
        console2.log("STR", address(str));
        console2.log("StateraRobots", address(robots));
        console2.log("RobotsAllocationVault (empty)", address(vault));
    }
}
