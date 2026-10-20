// DEV ONLY — test the swap-store endpoints on localhost before they're deployed. Serves /v2/token/:a/bars|history and
// /v2/wallet/:a/swaps from a LOCAL swaps.db (SWAPS_DB=…) with the API's own code (server/swap-store.ts), and forwards every
// other /v2 path to the real API through the SSH tunnel (127.0.0.1:18790, key ~/.config/statera/v2.key).
//   SWAPS_DB=~/bt/statera-swaps-data/swaps.db node --disable-warning=ExperimentalWarning scripts/dev-swaps-api.ts
//   STATERA_V2_DEV=http://127.0.0.1:18791 npm run dev
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import * as Swaps from '../server/swap-store.ts';

const KEY = (() => { try { return fs.readFileSync(`${os.homedir()}/.config/statera/v2.key`, 'utf8').trim(); } catch { return ''; } })();
const UP = 'http://127.0.0.1:18790';
const json = (res: http.ServerResponse, s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(b)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x'), p = u.pathname.replace(/^\/v2/, '');
  let m = p.match(/^\/token\/(0x[0-9a-fA-F]{40})\/bars$/);
  if (m) { const b = u.searchParams.get('before'); return json(res, 200, Swaps.candles(m[1].toLowerCase(), u.searchParams.get('res') || '5m', Number(u.searchParams.get('limit') || 1000), b ? Number(b) : undefined)); }
  m = p.match(/^\/token\/(0x[0-9a-fA-F]{40})\/history$/);
  if (m) { const b = u.searchParams.get('before'), sd = u.searchParams.get('side'); return json(res, 200, Swaps.trades(m[1].toLowerCase(), Number(u.searchParams.get('limit') || 100), b ? Number(b) : undefined, sd === 'buy' || sd === 'sell' ? sd : undefined, Number(u.searchParams.get('min') || 0), u.searchParams.get('maker') || undefined)); }
  m = p.match(/^\/token\/(0x[0-9a-fA-F]{40})\/(flow|traders|profitability)$/);
  if (m) { const a = m[1].toLowerCase(), so = u.searchParams.get('sort') as any; return json(res, 200, m[2] === 'flow' ? Swaps.flow(a) : m[2] === 'traders' ? Swaps.topTraders(a, so || 'pnl', Number(u.searchParams.get('limit') || 50)) : Swaps.profitability(a)); }
  m = p.match(/^\/wallet\/(0x[0-9a-fA-F]{40})\/swaps$/);
  if (m) {
    // the real API reads the wallet's tx list from its wallet index; here it comes from the tunnel's /transfers
    const t = await fetch(`${UP}/v2/wallet/${m[1]}/transfers?limit=5000`, { headers: { 'x-relay-key': KEY } }).then((r) => r.json()).catch(() => null) as any;
    if (!t?.transfers) return json(res, 200, { wallet: m[1], building: true, swaps: [] });
    return json(res, 200, { wallet: m[1], at: t.at, swaps: Swaps.swapsInTxs(t.transfers.map((x: any) => x.h), u.searchParams.get('token') || undefined) });
  }
  try {
    const r = await fetch(`${UP}${u.pathname}${u.search}`, { headers: { 'x-relay-key': KEY } });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
  } catch { json(res, 502, { error: 'tunnel down' }); }
}).listen(18791, () => console.log('dev swaps api on :18791'));
