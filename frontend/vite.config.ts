/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
      // proxy the Yjs WebSocket upgrade through to the
      // backend in dev. Without this, /ws/projects/* 404s here even
      // though the prod nginx config handles it.
      '/ws': {
        target: (process.env.VITE_API_TARGET || 'http://localhost:3001').replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    // vitest harness for the editor frontend. jsdom gives us
    // a DOM for @testing-library/react; globals: true lets tests use
    // `describe` / `it` / `expect` without imports (mirrors the
    // player-app config so the two workspaces read the same).
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
  },
});
