import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Dev proxy so XNT price (XDEX, no CORS) works locally too. In prod Vercel rewrites /api/xdex.
  server: {
    proxy: {
      '/api/xdex': { target: 'https://api.xdex.xyz', changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/xdex/, '') },
    },
  },
});
