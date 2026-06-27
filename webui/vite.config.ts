import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadProjectEnv } from '../env.js';

loadProjectEnv();
const BACKEND = process.env.PERSENG_BACKEND_URL || 'http://127.0.0.1:7717';

export default defineConfig({
  define: {
    __PERSENG_DEV_BACKEND_URL__: JSON.stringify(BACKEND),
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // dev only: 将 WebUI 使用的 API 前缀代理到 7717
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
