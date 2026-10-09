import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const backend = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  root: path.join(root, 'web'),
  plugins: [react()],
  resolve: { alias: { '@shared': path.join(root, 'shared') } },
  build: {
    outDir: path.join(root, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // React changes rarely and the app often: a separate file lets a browser keep it cached across updates. (The canvas library is not named here:
        // it simply travels with the editor, which loads only when a server is opened.)
        manualChunks(id) {
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    fs: { allow: [root] },
    // In dev, set BASE_URL=http://localhost:5173 so OAuth redirects and the Origin check line up.
    proxy: { '/api': backend, '/auth': backend, '/s': backend, '/i': backend },
  },
});
