import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `npm run build` writes web/dist, which the server serves. `npm run dev:web` serves the page with hot
// reload on http://localhost:5173 and sends /api to the server (npm run dev, port 4747 by default).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || `http://localhost:${process.env.PORT || 4747}` },
  },
});
