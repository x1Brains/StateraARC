import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';

// DEV ONLY: /api/v2/* (board, wallet holdings, P&L transfers) is a Vercel function in prod that relays to the VPS API
// (server/statera-api.ts, 127.0.0.1:8790 behind a key). Locally there is no Vercel, so P&L never loaded on localhost.
// With an SSH tunnel up (ssh -N -L 18790:127.0.0.1:8790 x1b-prod) and the key in ~/.config/statera/v2.key, the dev
// server talks to the same API directly. Without them the proxy is simply not added (site falls back to v1 like before).
const V2_KEY = (() => { try { return fs.readFileSync(`${os.homedir()}/.config/statera/v2.key`, 'utf8').trim(); } catch { return ''; } })();

export default defineConfig({
  plugins: [react()],
  // Dev proxy so XNT price (XDEX, no CORS) works locally too. In prod Vercel rewrites /api/xdex.
  server: {
    proxy: {
      ...(V2_KEY ? { '/api/v2': { target: 'http://127.0.0.1:18790', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/v2/, '/v2'), headers: { 'x-relay-key': V2_KEY } } } : {}),
      '/api/xdex': { target: 'https://api.xdex.xyz', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/xdex/, '') },
      // Warp launchpad API (Arc mainnet 5042 live token data) — no CORS, so proxy it.
      '/api/warp': { target: 'https://warp-arc-production.up.railway.app/api', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/warp/, '') },
      // RadarDEX aggregator (ALL Arc launchpads: argus/tolly/long/dyor/o1/warp… + token icons + portfolio) — no CORS, proxy it.
      '/api/radar': { target: 'https://api.radardex.pro', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/radar/, '') },
    },
  },
});
