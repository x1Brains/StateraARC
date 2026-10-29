# Statera (STR) — deployments

## ⭐ Arc MAINNET (chain 5042) — LIVE 2026-10-16
| Contract | Address |
|---|---|
| **STR (Statera)** — plain ERC-20, no owner, no tax, no mint, burnable+permit | `0xaAEeA145196107F96A209A843e4f14A69dAe99D0` |
| **Statera Robots** (X1CITY) — 4,444, $8→$44, random design at mint, 10,000 STR/mint | `0xA57C7AC417b3895F3b865119710c90a1733c5ac0` |
| RobotsAllocationVault (empty after release) | `0x2a89D9711204bbEffD36d9b8124B19C59493102c` |

**Statera Router** (UniversalPairRouterV2, ownerless, swaps through an EXACT pool — source `~/bt/arc/contracts/UniversalPairRouterV2.sol`) `0x82f14d28a1d8D3e08ef88B00275d7B053124D5d2` · deployed 2026-10-29 by the lab wallet `0x398c96b846966eaA7Fdf56F89A028DE9e8c9598a`, tx `0xac9c97eebc18113cfd90211a42ff80576083441ed5d19ce89e0fc047768b1194` · proven with a real $0.05 USDC→WARP→USDC round trip (txs `0x3c649302…`, `0xd4790687…`).

Deployer/owner `0x125c2aB36e45A161ADb8BFed417f514563DFBAa9` (holds 20% game STR) · Treasury `0x731CE24A5b475006A466B9B3Bf69707999b328DF` (20% STR, mint USDC, 5% royalty) · Team `0x286262070270a2E8FCbD1984d143837f05635ad5` (10%).
baseURI `https://arweave.net/4qP1Yfo1WVj3YWJG-NEDh7RN0ZHmcWtiomF8J4tfoVI/`. Verified on-chain after deploy: split exact, mint open at $8.00. **Metadata LOCKED 2026-10-18** (`lockMetadata` tx `0xd89e8d1a51d8020fe68fec465108970dce1d21d5b6220766f7eba5eec514a891`, block 26,537,412) — `metadataLocked() == true`, the art/metadata can never change.

**Team allocation on mainnet:** the 10% team share (8,888,000 STR) was sent to the team wallet at deploy — there is **no vesting contract on mainnet** (owner decision). The vesting contract below existed only in the testnet set.

## Arc TESTNET (chain 5042002) — CURRENT set (2026-10-13, redeployed: Robots now ERC721Enumerable)
| Contract | Address |
|---|---|
| STR token | `0x83631BD1DbD132E609b76A3dA3b1265062619191` |
| Robots allocation vault (released) | `0xDD1A9ce8ca2091755c4D36A8961Ce2321E62cF90` |
| Team vesting (8,888,000 STR, 365 days) | `0x042F15c1DCBcAeF31661B9a702C203A32da778DD` |
| **Statera Robots** (4,444, $8→$44, enumerable) | `0x9fa6eC7174fF975a414241Ec55D99F4949601De7` |

Verified (testnet only, earlier design): supply 88,880,000; Robots holds 44,440,000 STR (tax-exempt); vesting 8,888,000; deployer 35,552,000; tax 4%. Mainnet STR has no tax and no vesting.

### Superseded testnet set (first deploy, not enumerable — do not use)
STR `0x2cB3Cb9b940b4eced97D26537b7b2E7e37809769`, vault `0x22420E3079E8e7f2064E63f30d0958A3bA61541a`,
vesting `0x116f95d06460692F3e3Cb2FA21e9933a1Ad31b70`, Robots `0x602d48Fd56686c738f2Bde4573A6d3e75d638125` (Robot #1 test mint;
its 44,430,000 STR are stranded there — testnet only).

## Tokenomics (mainnet, as deployed 10-16)
88,880,000 STR fixed (no mint fn): 50% Robots NFTs (10,000 per Robot × 4,444) · 20% game & staking ·
20% treasury & liquidity · 10% team (unvested wallet — the 12-month vesting was testnet-only).

## Next
- Bridge/keeper hookup: Robots = Arc Elite citizens (allowlist contract, keeper watches Minted, one MAIN Robot per wallet), Citizen ID card + Elite perks.
- Art + metadata (setBaseURI) and the site mint page (replace the coin-NFT page).
- Check fee-on-transfer compatibility with the Arc DEXes Statera routes through.
- Mainnet: deploy Robots first and mint the 50% straight into it (no vault).
