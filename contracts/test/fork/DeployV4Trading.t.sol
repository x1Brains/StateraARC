// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {StrToken} from "../../src/StrToken.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";

/// Minimal Uniswap V4 core types (PoolManager on Arc testnet+mainnet 0x8366a39c…)
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }
struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IPM {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory p, bytes calldata h) external returns (int256, int256);
    function swap(PoolKey memory key, SwapParams memory p, bytes calldata h) external returns (int256);
    function sync(address c) external;
    function settle() external payable returns (uint256);
    function take(address c, address to, uint256 amount) external;
}
contract MockUSDC is ERC20 { constructor() ERC20("USDC", "USDC") { _mint(msg.sender, 1e30); } function decimals() public pure override returns (uint8) { return 6; } }

/// Plays the role of the Universal Router: pays exactly what the pool says it is owed (SETTLE_ALL).
contract Router {
    IPM pm; constructor(IPM p) { pm = p; }
    PoolKey key; address payer;
    function act(PoolKey memory k, bytes memory op) external returns (bytes memory) { key = k; payer = msg.sender; return pm.unlock(op); }
    function unlockCallback(bytes calldata op) external returns (bytes memory) {
        (uint8 kind, int256 a, bool z) = abi.decode(op, (uint8, int256, bool));
        int256 d;
        if (kind == 0) { (d, ) = pm.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, a, 0), ""); }
        else { d = pm.swap(key, SwapParams(z, a, z ? 4295128740 : 1461446703485210103287273052203988822378723970341), ""); }
        int128 d0 = int128(d >> 128); int128 d1 = int128(d);
        _settle(key.currency0, d0); _settle(key.currency1, d1);
        return abi.encode(d0, d1);
    }
    function _settle(address c, int128 v) internal {
        if (v < 0) { pm.sync(c); ERC20(c).transferFrom(payer, address(pm), uint256(uint128(-v))); pm.settle(); }
        else if (v > 0) { pm.take(c, payer, uint256(uint128(v))); }
    }
}


/// Runs the REAL mainnet deploy script on an Arc-testnet fork, then a stranger opens an UNHOOKED V4 pool
/// (what we expect someone to do) and a normal holder buys AND sells. Also checks the 4% on wallet sends.
contract DeployV4TradingForkTest is Test {
    IPM constant PM = IPM(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant TREASURY = 0x731CE24A5b475006A466B9B3Bf69707999b328DF;

    function test_strangerPool_buyAndSell_afterRealDeploy() public {
        vm.createSelectFork("https://rpc.testnet.arc.io");
        uint256 pk = uint256(keccak256("throwaway deployer"));
        vm.setEnv("DEPLOYER_PK", vm.toString(bytes32(pk)));
        DeployMainnet dep = new DeployMainnet(); dep.run();
        StrToken str = dep.str(); address deployer = vm.addr(pk);

        // a STRANGER (not exempt) gets STR the normal way: someone sends it to them (4% taxed)
        address stranger = makeAddr("stranger"); address holder = makeAddr("holder");
        uint256 t0 = str.balanceOf(TREASURY);
        vm.prank(TREASURY); str.transfer(holder, 1_000e18);
        vm.prank(holder); str.transfer(stranger, 500e18);
        assertEq(str.balanceOf(stranger), 500e18, "no tax on wallet send");
        assertEq(str.balanceOf(TREASURY), t0 - 1_000e18, "nothing skimmed");
        console2.log("wallet send 500 STR -> received", str.balanceOf(stranger) / 1e18);

        // stranger opens an UNHOOKED pool with their own (mock) USDC and adds liquidity
        vm.startPrank(stranger);
        MockUSDC usdc = new MockUSDC(); Router r = new Router(PM);
        (address c0, address c1) = address(str) < address(usdc) ? (address(str), address(usdc)) : (address(usdc), address(str));
        PoolKey memory key = PoolKey(c0, c1, 3000, 60, address(0));
        PM.initialize(key, 79228162514264337593543950336);
        str.approve(address(r), type(uint256).max); usdc.approve(address(r), type(uint256).max);
        r.act(key, abi.encode(uint8(0), int256(1e20), false));
        usdc.transfer(holder, 1_000_000e6);
        vm.stopPrank();

        // a normal holder BUYS then SELLS through it
        vm.startPrank(holder);
        str.approve(address(r), type(uint256).max); usdc.approve(address(r), type(uint256).max);
        uint256 s0 = str.balanceOf(holder);
        bool zBuy = key.currency0 != address(str);
        r.act(key, abi.encode(uint8(1), int256(-1000e6), zBuy));
        uint256 s1 = str.balanceOf(holder);
        assertGt(s1, s0, "buy received STR");
        r.act(key, abi.encode(uint8(1), -int256((s1 - s0)), !zBuy));               // sell everything just bought
        uint256 s2 = str.balanceOf(holder);
        vm.stopPrank();
        assertEq(s2, s0, "sell went through, exact amount left the wallet");
        console2.log("BUY ok  - STR wei bought", s1 - s0);
        console2.log("SELL ok - STR wei sold  ", s1 - s2);
    }
}
