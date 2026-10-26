# Statera on-chain contracts (Arc mainnet)

| Contract | Address (Arc mainnet, chain 5042) |
|---|---|
| **STR — Statera token** (`src/StrToken.sol`) | `0xaAEeA145196107F96A209A843e4f14A69dAe99D0` |
| **Statera Robots** — 4,444 NFT, ticker X1CITY (`src/StateraRobots.sol`) | `0xA57C7AC417b3895F3b865119710c90a1733c5ac0` |
| Robots allocation vault (empty, released to Robots at deploy) | `0x2a89D9711204bbEffD36d9b8124B19C59493102c` |

**STR**: 88,880,000 fixed supply, minted once in the constructor — no mint function, no owner, no admin keys, no transfer tax, no pause/blacklist. Burnable (on-chain `totalBurned`) + EIP-2612 permit.
Split: 50% → Statera Robots contract (10,000 STR per mint) · 20% game & staking · 20% treasury & liquidity · 10% team.

**Statera Robots**: price rises in a straight line from $8 (Robot #1) to $44 (Robot #4,444), paid in Arc USDC to the treasury.
Every mint sends the minter 10,000 STR in the same transaction — minting is the only way STR leaves the Robots allocation.
One mint per address; the Robot design is drawn at random at mint and revealed instantly (art + metadata on Arweave).
5% resale royalty (ERC-2981).

## Owner powers and known limits (stated plainly, 2026-10-26)

- **STR** has no owner and no admin functions at all.
- **Statera Robots** still has an owner (`0x125c2aB36e45A161ADb8BFed417f514563DFBAa9`) who can pause minting and change the
  treasury / royalty receiver. The art/metadata is **locked forever** (`metadataLocked() == true` since 2026-10-18), and
  ownership can only be renounced while the art is locked and minting is not paused.
- **Team 10%** (8,888,000 STR) sits in the team wallet with no vesting contract on mainnet.
- **"One mint per address"** is per address: the same person can mint again from another wallet, and contracts may mint.
- **Design draw on Arc:** Arc's `block.prevrandao` is always 0, so the draw (prevrandao, previous block hash, minter,
  token number, timestamp) is computable from public data, not secret. The contract comment "nobody can know which robot
  the next mint gives" overstates it: a minting *contract* could check its design and revert to try again. The contract
  is immutable, so this cannot be patched; we replayed every mint so far (all 18 as of 2026-10-26) and none came from a
  contract or shows any sign of re-rolling. Rarity counts: Mythic 88 · Legendary 379 · Epic 658 · Rare 1,192 · Common 2,127.

Build/test with Foundry (`forge install` openzeppelin + forge-std into `lib/`, then `forge test`). 33 tests incl. fork tests against Arc.
