// LENDING ON ARC — Morpho Blue + Aave V4, read from their contracts (Network page). Addresses verified 2026-09-28 against the
// protocols' own docs/APIs AND on chain: Morpho Blue 0x34CD…7fCD (docs.morpho.org addresses; market(id) matched Morpho's API
// to the unit), Aave V4 Core Hub 0x1728…F79C (AaveKit API; getAssetCount = 4). Worth knowing: these two contracts are
// cirBTC's #1 (69.66%) and #2 (20.77%) holders — that cirBTC is loan collateral, not two whales.
// Morpho markets are found by their CreateMarket events (one-time sweep, then incremental; ids persisted). Every amount is
// raw on-chain units ÷ the token's decimals read from the token contract — never a guessed decimals value.
type Rpc = (method: string, params: unknown[]) => Promise<any>;
type Call = (to: string, data: string) => Promise<any>;
import fs from 'node:fs';
import path from 'node:path';

const MORPHO = '0x34cd04070dd72b14e241112f6d83812df5af7fcd';
const MORPHO_FROM = 1_208_882;                 // first CreateMarket (verified in a live log)
const T_CREATE_MARKET = '0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac';
const SEL_MARKET = '0x5c60e39a';               // market(bytes32) → supplyAssets, supplyShares, borrowAssets, borrowShares, lastUpdate, fee
const SEL_PARAMS = '0x2c3c9157';               // idToMarketParams(bytes32) → loanToken, collateralToken, oracle, irm, lltv
const AAVE_HUB = '0x17288dfc86205301064577b98b02b81017e6f79c';
const SEL_ASSET_COUNT = '0xa0aead4d';          // getAssetCount()
const SEL_ADDED = '0x24ba667f';                // getAddedAssets(uint256) — supplied
const SEL_OWED = '0x0752c44c';                 // getAssetTotalOwed(uint256) — borrowed
// getAssetUnderlyingAndDecimals(uint256) → (address, uint8) — aave/aave-v4 src/hub/interfaces/IHubBase.sol (read 09-28)
const SEL_UNDERLYING = '0xde079b57';
const STATE_FILE = process.env.LENDING_STATE || '/root/statera-api-state/lending.json';
const RANGE = 95_000;                          // tenderly/blockdaemon accept ~100k-block getLogs (address-filtered, few results)

const word = (hex: string, i: number) => BigInt('0x' + (hex.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'));
const addr = (hex: string, i: number) => '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64).toLowerCase();
const pad = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');

interface MorphoMarket { id: string; loan: string; collateral: string; lltv: number }
let st: { markets: MorphoMarket[]; scannedTo: number; aaveUnderlying: Record<number, string> } = { markets: [], scannedTo: MORPHO_FROM - 1, aaveUnderlying: {} };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* fresh */ }
const save = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(st)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch { /* next time */ } };
const decimalsCache = new Map<string, number>();
export const lendingStats = { sweeps: 0, errors: 0, lastOk: 0 };

let snapshot: any = null;
export const lendingSummary = () => snapshot;

/** One refresh: extend the CreateMarket sweep (a few ranges per call so it never floods), then read every market + the Hub. */
export async function refreshLending(rpc: Rpc, call: Call, getLogsBig: (p: any) => Promise<any[] | null>, priceOf: (token: string) => number | null, symbolOf: (token: string) => string | null) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  for (let k = 0; k < 60 && st.scannedTo < head; k++) {
    const from = st.scannedTo + 1, to = Math.min(head, from + RANGE - 1);
    const logs = await getLogsBig({ address: MORPHO, topics: [T_CREATE_MARKET], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) });
    if (!Array.isArray(logs)) { lendingStats.errors++; break; } // resumes from here next refresh (persisted)
    for (const l of logs) {
      const id = l.topics[1];
      if (st.markets.some((m) => m.id === id)) continue;
      // CreateMarket(bytes32 indexed id, MarketParams) — data = loanToken, collateralToken, oracle, irm, lltv
      st.markets.push({ id, loan: addr(l.data, 0), collateral: addr(l.data, 1), lltv: Number(word(l.data, 4)) / 1e18 });
    }
    st.scannedTo = to; lendingStats.sweeps++;
  }
  save();
  const dec = async (t: string) => {
    if (decimalsCache.has(t)) return decimalsCache.get(t)!;
    const r = await call(t, '0x313ce567'); if (!r || r === '0x') return null;
    const d = Number(BigInt(r)); if (!(d >= 0 && d <= 36)) return null; decimalsCache.set(t, d); return d;
  };
  const markets = [];
  for (const m of st.markets) {
    const r = await call(MORPHO, SEL_MARKET + m.id.slice(2)); if (!r || r.length < 2 + 64 * 6) continue;
    const d = await dec(m.loan); if (d == null) continue;
    const supply = Number(word(r, 0)) / 10 ** d, borrow = Number(word(r, 2)) / 10 ** d;
    const px = priceOf(m.loan);
    markets.push({ id: m.id, loan: m.loan, loanSymbol: symbolOf(m.loan), collateral: m.collateral, collateralSymbol: symbolOf(m.collateral), lltv: m.lltv,
      supply, borrow, supplyUsd: px != null ? supply * px : null, borrowUsd: px != null ? borrow * px : null, utilization: supply > 0 ? borrow / supply : null });
  }
  markets.sort((a, b) => (b.supplyUsd ?? 0) - (a.supplyUsd ?? 0));
  const aave = [];
  const n = Number(BigInt((await call(AAVE_HUB, SEL_ASSET_COUNT)) || '0x0'));
  for (let i = 0; i < Math.min(n, 32); i++) {
    const [a, o] = await Promise.all([call(AAVE_HUB, SEL_ADDED + pad(i)), call(AAVE_HUB, SEL_OWED + pad(i))]);
    if (!a || !o || a === '0x') continue;
    let token = st.aaveUnderlying[i] || null;
    if (!token) { const u = await call(AAVE_HUB, SEL_UNDERLYING + pad(i)); if (u && u.length >= 2 + 128) { token = addr(u, 0); st.aaveUnderlying[i] = token; save(); } }
    // Decimals from the TOKEN contract (the Hub reports them too; the token is the ground truth). Unknown = not shown.
    const d = token ? await dec(token) : null; if (d == null) continue;
    const supply = Number(BigInt(a)) / 10 ** d, borrow = Number(BigInt(o)) / 10 ** d, px = priceOf(token!);
    aave.push({ assetId: i, token, symbol: symbolOf(token!), supply, borrow, supplyUsd: px != null ? supply * px : null, borrowUsd: px != null ? borrow * px : null, utilization: supply > 0 ? borrow / supply : null });
  }
  const sum = (xs: { supplyUsd: number | null; borrowUsd: number | null }[], k: 'supplyUsd' | 'borrowUsd') => xs.reduce((s, x) => s + (x[k] ?? 0), 0);
  snapshot = {
    at: Date.now(),
    morpho: { address: MORPHO, markets, supplyUsd: sum(markets, 'supplyUsd'), borrowUsd: sum(markets, 'borrowUsd'), sweptTo: st.scannedTo, head },
    aave: { hub: AAVE_HUB, assets: aave, supplyUsd: sum(aave, 'supplyUsd'), borrowUsd: sum(aave, 'borrowUsd') },
  };
  lendingStats.lastOk = Date.now();
}
