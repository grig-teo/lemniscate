import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  // VITE_BASE_PATH lets the same image serve the SPA under a subpath
  // (e.g. /lemniscate/ on a shared domain). Defaults to root.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // In dev the SPA calls the backend through this proxy (same-origin),
      // matching the nginx /api -> backend proxy used in production.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
