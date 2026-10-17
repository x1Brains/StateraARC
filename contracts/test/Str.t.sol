// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StrToken} from "../src/StrToken.sol";
import {RobotsAllocationVault} from "../src/RobotsAllocationVault.sol";

/// STR = plain, sealed ERC-20 (owner 10-16): no owner, no tax, no mint, burnable, permit.
contract StrTest is Test {
    StrToken str;
    RobotsAllocationVault vault;
    address owner = makeAddr("owner");
    address game = makeAddr("game");
    address treasury = makeAddr("treasury");
    address team = makeAddr("team");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vault = new RobotsAllocationVault(owner);
        str = new StrToken(address(vault), game, treasury, team);
    }

    function test_supplyAndSplit() public view {
        assertEq(str.totalSupply(), 88_880_000e18);
        assertEq(str.balanceOf(address(vault)), 44_440_000e18);   // 50% Robots
        assertEq(str.balanceOf(game), 17_776_000e18);             // 20%
        assertEq(str.balanceOf(treasury), 17_776_000e18);         // 20%
        assertEq(str.balanceOf(team), 8_888_000e18);              // 10%
        assertEq(str.name(), "Statera"); assertEq(str.symbol(), "STR"); assertEq(str.decimals(), 18);
    }

    function test_noTaxAnywhere() public {
        vm.prank(game); str.transfer(alice, 1_000e18);
        vm.prank(alice); str.transfer(bob, 1_000e18);
        assertEq(str.balanceOf(bob), 1_000e18);                   // every send arrives whole
        vm.prank(bob); str.approve(alice, 600e18);
        vm.prank(alice); str.transferFrom(bob, treasury, 600e18);
        assertEq(str.balanceOf(treasury), 17_776_000e18 + 600e18);
    }

    function test_noOwnerNoAdminFunctions() public {
        // the token has no owner()/setTaxBps/setTaxExempt/mint/pause — any such call reverts at the ABI level
        (bool ok1, ) = address(str).call(abi.encodeWithSignature("owner()"));
        (bool ok2, ) = address(str).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1));
        (bool ok3, ) = address(str).call(abi.encodeWithSignature("setTaxBps(uint16)", 800));
        (bool ok4, ) = address(str).call(abi.encodeWithSignature("pause()"));
        assertFalse(ok1); assertFalse(ok2); assertFalse(ok3); assertFalse(ok4);
        assertEq(str.totalSupply(), 88_880_000e18);
    }

    function test_burnShrinksSupply() public {
        vm.prank(game); str.transfer(alice, 1_000e18);
        vm.prank(alice); str.burn(250e18);
        assertEq(str.totalSupply(), 88_880_000e18 - 250e18);
        assertEq(str.totalBurned(), 250e18);
    }

    function test_burnFromNeedsAllowance() public {
        vm.prank(game); str.transfer(alice, 100e18);
        vm.expectRevert();
        vm.prank(bob); str.burnFrom(alice, 10e18);
        vm.prank(alice); str.approve(bob, 10e18);
        vm.prank(bob); str.burnFrom(alice, 10e18);
        assertEq(str.totalBurned(), 10e18);
    }

    function test_permitGaslessApproval() public {
        uint256 pk = 0xA11CE; address signer = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", str.DOMAIN_SEPARATOR(), keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            signer, bob, 5e18, str.nonces(signer), deadline))));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, digest);
        str.permit(signer, bob, 5e18, deadline, v, r, s_);
        assertEq(str.allowance(signer, bob), 5e18);
    }

    function test_vaultReleasesOnceToRobots() public {
        address robots = address(new Dummy());                       // vault only releases to a CONTRACT (by design)
        vm.prank(owner); vault.release(str, robots);
        assertEq(str.balanceOf(robots), 44_440_000e18);
        assertEq(str.balanceOf(address(vault)), 0);
    }
}

contract Dummy {}
