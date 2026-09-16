import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Dev proxy so XNT price (XDEX, no CORS) works locally too. In prod Vercel rewrites /api/xdex.
  server: {
    proxy: {
      '/api/xdex': { target: 'https://api.xdex.xyz', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/xdex/, '') },
      // Warp launchpad API (Arc mainnet 5042 live token data) — no CORS, so proxy it.
      '/api/warp': { target: 'https://warp-arc-production.up.railway.app/api', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/warp/, '') },
      // RadarDEX aggregator (ALL Arc launchpads: argus/tolly/long/dyor/o1/warp… + token icons + portfolio) — no CORS, proxy it.
      '/api/radar': { target: 'https://api.radardex.pro', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/radar/, '') },
    },
  },
});
