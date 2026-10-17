// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test, console2} from "forge-std/Test.sol";
interface IE { function balanceOf(address) external view returns (uint256); function transfer(address,uint256) external returns (bool); function symbol() external view returns (string memory); }
contract Probe is Test {
    function _probe(address tok, address holder) internal {
        IE t = IE(tok); address to = makeAddr(vm.toString(tok)); holder = makeAddr("holder");
        uint256 amt = 1_000e18; deal(tok, holder, amt);
        vm.prank(holder); t.transfer(to, amt);
        uint256 got = t.balanceOf(to);
        console2.log(t.symbol(), "sent", amt); console2.log("  received", got, got == amt ? "NO TAX on wallet transfer" : "TAXED");
    }
    function test_arc_tokens() public {
        vm.createSelectFork("https://rpc.mainnet.arc.io");
        _probe(0x12cE1F970722ca6e08364b60099b3d25c09b5434, 0x580d9d45A739f3F5d5b5834dEF37a10ED15E96b5);   // ARCX10 (owner wallet holds 105k)
        _probe(0x8E98A62a995A50eca9979bfa016f91bf36A8F9D9, address(0));   // UpSideDownCat
    }
}
