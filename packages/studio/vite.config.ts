import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:7300', ws: true } } },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
