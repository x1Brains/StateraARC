// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {StrToken} from "../src/StrToken.sol";
import {RobotsAllocationVault} from "../src/RobotsAllocationVault.sol";
import {StateraRobots} from "../src/StateraRobots.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract RobotsTest is Test {
    MockUSDC usdc;
    StrToken str;
    RobotsAllocationVault vault;
    StateraRobots robots;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address fees = makeAddr("fees");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new RobotsAllocationVault(owner);
        VestingWallet team = new VestingWallet(owner, uint64(block.timestamp), 365 days);
        str = new StrToken(address(vault), owner, treasury, address(team));
        robots = new StateraRobots(owner, usdc, str, treasury, "ipfs://robots/");
        vm.startPrank(owner, owner);
        vault.release(str, address(robots));
        vm.stopPrank();
    }

    function _mint(address who, string memory handle) internal returns (uint256) {
        uint256 price = robots.currentPrice();
        usdc.mint(who, price);
        vm.startPrank(who, who);
        usdc.approve(address(robots), price);
        uint256 id = robots.mint(handle, price);
        vm.stopPrank();
        return id;
    }

    function test_curveEndpoints() public view {
        assertEq(robots.priceOf(1), 8_000_000);        // $8.00
        assertEq(robots.priceOf(4_444), 44_000_000);   // $44.00
        assertEq(robots.priceOf(500), 12_043_214);     // $12.043214
        assertEq(robots.currentPrice(), 8_000_000);
        assertEq(robots.strRemaining(), 44_440_000e18);
    }

    function test_curveSumMatchesPlan() public view {
        uint256 total;
        for (uint256 n = 1; n <= 4_444; n++) total += robots.priceOf(n);
        // $115,544 at sell-out (integer floor per mint loses < $0.01 each).
        assertApproxEqAbs(total, 115_544_000_000, 4_444);
    }

    function test_mintPaysTreasuryAndStr() public {
        uint256 id = _mint(alice, "alice_bot");
        assertEq(id, 1);
        assertEq(robots.ownerOf(1), alice);
        assertEq(usdc.balanceOf(treasury), 8_000_000);
        assertEq(str.balanceOf(alice), 10_000e18);     // whole — no tax on the payout
        assertEq(str.balanceOf(fees), 0);
        assertEq(robots.totalMinted(), 1);
        assertEq(robots.currentPrice(), robots.priceOf(2));
        assertEq(robots.tokenURI(1), string.concat("ipfs://robots/", vm.toString(robots.artOf(1)), ".json"));
    }

    function test_onePerWallet() public {
        _mint(alice, "alice_bot");
        uint256 price = robots.currentPrice();
        usdc.mint(alice, price);
        vm.startPrank(alice, alice);
        usdc.approve(address(robots), price);
        vm.expectRevert(StateraRobots.AlreadyMinted.selector);
        robots.mint("again", price);
        vm.stopPrank();
    }

    function test_secondaryBuyerCanStillMintOwn() public {
        _mint(alice, "alice_bot");
        vm.prank(alice, alice);
        robots.transferFrom(alice, bob, 1);            // secondary sale
        assertEq(robots.ownerOf(1), bob);
        _mint(bob, "bob_bot");                         // bob never minted → allowed
        assertEq(robots.balanceOf(bob), 2);
        // Enumerable: the site lists a wallet's Robots on-chain.
        assertEq(robots.tokenOfOwnerByIndex(bob, 0), 1);
        assertEq(robots.tokenOfOwnerByIndex(bob, 1), 2);
        assertEq(robots.totalSupply(), 2);
    }

    function test_maxPriceGuard() public {
        usdc.mint(alice, 8_000_000);
        vm.startPrank(alice, alice);
        usdc.approve(address(robots), 8_000_000);
        vm.expectRevert(abi.encodeWithSelector(StateraRobots.PriceAboveMax.selector, 8_000_000, 7_999_999));
        robots.mint("alice_bot", 7_999_999);
        vm.stopPrank();
    }

    function test_badHandleAndPause() public {
        usdc.mint(alice, 8_000_000);
        vm.startPrank(alice, alice);
        usdc.approve(address(robots), 8_000_000);
        vm.expectRevert(StateraRobots.BadHandle.selector);
        robots.mint("", 8_000_000);
        vm.stopPrank();
        vm.prank(owner, owner);
        robots.setMintPaused(true);
        vm.prank(alice, alice);
        vm.expectRevert(StateraRobots.Paused.selector);
        robots.mint("alice_bot", 8_000_000);
    }

    function test_needsUsdc() public {
        vm.prank(alice, alice);
        vm.expectRevert();                             // no allowance / balance
        robots.mint("alice_bot", 8_000_000);
        assertEq(robots.totalMinted(), 0);
    }

    function test_royalty5pctToTreasury() public view {
        (address recv, uint256 amt) = robots.royaltyInfo(1, 100e6);
        assertEq(recv, treasury);
        assertEq(amt, 5e6);
    }

    function test_soldOutAfter4444() public {
        // Fast path: pretend 4,443 are minted, then mint the last one and check the cap.
        vm.store(address(robots), bytes32(uint256(_slotTotalMinted())), bytes32(uint256(4_443)));
        assertEq(robots.currentPrice(), 44_000_000);
        _mint(alice, "last_bot");
        assertEq(robots.ownerOf(4_444), alice);
        usdc.mint(bob, 44_000_000);
        vm.startPrank(bob, bob);
        usdc.approve(address(robots), 44_000_000);
        vm.expectRevert(StateraRobots.SoldOut.selector);
        robots.mint("too_late", 44_000_000);
        vm.stopPrank();
    }

    function _slotTotalMinted() internal returns (uint256 slot) {
        // Find the storage slot holding totalMinted by probing.
        for (slot = 0; slot < 40; slot++) {
            bytes32 before = vm.load(address(robots), bytes32(slot));
            vm.store(address(robots), bytes32(slot), bytes32(uint256(777)));
            bool hit = robots.totalMinted() == 777;
            vm.store(address(robots), bytes32(slot), before);
            if (hit) return slot;
        }
        revert("slot not found");
    }

    // ---- security / attack tests ----------------------------------------------

    function test_deploysOpen() public {                       // owner 10-16: mint is live the moment it deploys
        StateraRobots fresh = new StateraRobots(owner, usdc, str, treasury, "x");
        assertFalse(fresh.mintPaused());
    }

    function test_contractsCanMint_massAdoption() public {     // owner 10-16: bots/contracts welcome
        Reenter bot = new Reenter(robots, usdc);
        usdc.mint(address(bot), 1_000e6);
        bot.go();
        assertEq(robots.balanceOf(address(bot)), 1);              // still exactly ONE per wallet/contract
        assertEq(str.balanceOf(address(bot)), 10_000e18);
        assertTrue(bot.reentryBlocked());                          // re-entering mid-mint is still blocked
        assertEq(robots.totalMinted(), 1);
    }

    function test_randomArt_allUniqueAcrossFullSellout() public {
        vm.pauseGasMetering();
        bool[4445] memory seen;
        for (uint256 i = 1; i <= 4444; i++) {
            address w = address(uint160(0x100000 + i));
            uint256 price = robots.currentPrice(); usdc.mint(w, price);
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(i)))));
            vm.startPrank(w, w); usdc.approve(address(robots), price); robots.mint("h", price); vm.stopPrank();
            uint256 a = robots.artOf(i);
            assertTrue(a >= 1 && a <= 4444, "range");
            assertFalse(seen[a], "duplicate design");
            seen[a] = true;
        }
        assertEq(str.balanceOf(address(robots)), 0);
    }

    function test_revealedInstantly() public {
        uint256 id = _mint(alice, "alice");
        uint256 a = robots.artOf(id);
        assertGt(a, 0);
        assertEq(robots.tokenURI(id), string.concat("ipfs://robots/", vm.toString(a), ".json"));
    }

    function test_strangerCannotUseOwnerFunctions() public {
        vm.startPrank(alice, alice);
        vm.expectRevert(); robots.setMintPaused(true);
        vm.expectRevert(); robots.setBaseURI("evil://");
        vm.expectRevert(); robots.setTreasury(alice);
        vm.expectRevert(); robots.lockMetadata();
        vm.expectRevert(); robots.transferOwnership(alice);
        vm.stopPrank();
    }

    function test_lockMetadataIsForever() public {
        vm.startPrank(owner, owner);
        robots.lockMetadata();
        vm.expectRevert(StateraRobots.MetadataIsLocked.selector);
        robots.setBaseURI("https://changed/");
        vm.stopPrank();
        _mint(alice, "alice");
        assertEq(robots.tokenURI(1), string.concat("ipfs://robots/", vm.toString(robots.artOf(1)), ".json"));
    }

    function test_renounceOnlyWhenSafe() public {
        vm.startPrank(owner);
        vm.expectRevert(StateraRobots.RenounceDisabled.selector);   // art not locked yet
        robots.renounceOwnership();
        robots.lockMetadata();
        robots.setMintPaused(true);
        vm.expectRevert(StateraRobots.RenounceDisabled.selector);   // paused → would be stuck shut forever
        robots.renounceOwnership();
        robots.setMintPaused(false);
        robots.renounceOwnership();                                 // locked + open → allowed
        vm.stopPrank();
        assertEq(robots.owner(), address(0));
        vm.prank(owner); vm.expectRevert(); robots.setMintPaused(true);   // nobody can pause anymore
        _mint(alice, "alice");                                      // minting still works after renounce
        assertEq(robots.totalMinted(), 1);
    }

    function test_ownershipNeedsTwoSteps() public {
        vm.prank(owner, owner); robots.transferOwnership(bob);
        assertEq(robots.owner(), owner);                       // not yet
        vm.prank(alice, alice); vm.expectRevert(); robots.acceptOwnership();
        vm.prank(bob, bob); robots.acceptOwnership();
        assertEq(robots.owner(), bob);
    }

    function test_noWayToTakeStrExceptMinting() public {
        uint256 before = str.balanceOf(address(robots));
        _mint(alice, "a"); _mint(bob, "b");
        assertEq(str.balanceOf(address(robots)), before - 20_000e18);   // exactly 10k per mint, nothing else moved
    }

    function test_sendAwayThenMintAgainBlocked() public {
        _mint(alice, "alice");
        vm.prank(alice, alice); robots.transferFrom(alice, bob, 1);
        usdc.mint(alice, 100e6);
        vm.startPrank(alice, alice); usdc.approve(address(robots), 100e6);
        vm.expectRevert(StateraRobots.AlreadyMinted.selector);
        robots.mint("again", 100e6);
        vm.stopPrank();
    }

    function testFuzz_paysExactPriceNeverMore(uint8 n) public {
        for (uint256 i; i < n % 20; i++) _mint(makeAddr(vm.toString(i)), "h");
        uint256 price = robots.currentPrice(); uint256 t0 = usdc.balanceOf(treasury);
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice, alice); usdc.approve(address(robots), 1_000e6); robots.mint("alice", 1_000e6); vm.stopPrank();
        assertEq(usdc.balanceOf(treasury) - t0, price);
        assertEq(usdc.balanceOf(alice), 1_000e6 - price);
    }

    function test_artsOfBatch() public {
        _mint(alice, "a"); _mint(bob, "b");
        uint256[] memory a = robots.artsOf(1, 3);
        assertEq(a[0], robots.artOf(1)); assertEq(a[1], robots.artOf(2)); assertEq(a[2], 0);
    }

    function test_botFactorySnipesManyInOneTx() public {           // owner 10-16: bots welcome (1 per address)
        BotFactory f = new BotFactory(robots, usdc);
        usdc.mint(address(f), 1_000e6);
        uint256 t0 = usdc.balanceOf(treasury);
        f.snipe(25);
        assertEq(robots.totalMinted(), 25);
        assertEq(str.balanceOf(address(f)), 25 * 10_000e18);        // every mint pays the full 10,000 (STR has no tax)
        assertEq(robots.balanceOf(address(f)), 25);
        assertGt(usdc.balanceOf(treasury) - t0, 25 * 8e6 - 1);      // treasury paid for all 25
    }

    function test_mintGasStaysCheap() public {
        uint256 price = robots.currentPrice(); usdc.mint(alice, price);
        vm.startPrank(alice, alice); usdc.approve(address(robots), price);
        uint256 g = gasleft(); robots.mint("alice", price); g -= gasleft();
        vm.stopPrank();
        emit log_named_uint("gas per mint", g);
        assertLt(g, 400_000);
    }
}

contract Reenter {
    StateraRobots r; MockUSDC u; bool public reentryBlocked; bool inside;
    constructor(StateraRobots r_, MockUSDC u_) { r = r_; u = u_; }
    function go() external { u.approve(address(r), type(uint256).max); r.mint("attacker", 1_000e6); }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!inside) { inside = true; try r.mint("again", 1_000e6) { } catch { reentryBlocked = true; } }
        return this.onERC721Received.selector;
    }
}

contract BotMinter {
    constructor(StateraRobots r, MockUSDC u, address boss) {
        uint256 price = r.currentPrice();
        u.transferFrom(boss, address(this), price);
        u.approve(address(r), price);
        uint256 id = r.mint("bot", price);
        r.transferFrom(address(this), boss, id);
        IERC20Lite(address(r.str())).transfer(boss, 10_000e18);
    }
}
interface IERC20Lite { function transfer(address, uint256) external returns (bool); }
contract BotFactory {
    StateraRobots r; MockUSDC u;
    constructor(StateraRobots r_, MockUSDC u_) { r = r_; u = u_; }
    function snipe(uint256 n) external {
        u.approve(address(this), type(uint256).max);
        for (uint256 i; i < n; i++) {
            address next = vm_compute(i);
            u.approve(next, type(uint256).max);
            new BotMinter{salt: bytes32(i)}(r, u, address(this));
        }
    }
    function vm_compute(uint256 i) internal view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(i), keccak256(abi.encodePacked(type(BotMinter).creationCode, abi.encode(r, u, address(this))))));
        return address(uint160(uint256(h)));
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC721Received.selector; }
}
