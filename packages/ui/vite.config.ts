import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

const CORE = 'http://127.0.0.1:7600';

export default defineConfig({
  base: './',
  // Cast: @vitejs/plugin-react resolves the hoisted root vite's types, which differ from this package's vite 6.
  plugins: [react() as unknown as PluginOption],
  server: {
    port: 5173,
    proxy: {
      // WebSocket first so it wins over the generic /api rule.
      '/api/v1/events': { target: CORE, ws: true, changeOrigin: true },
      '/api': { target: CORE, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
