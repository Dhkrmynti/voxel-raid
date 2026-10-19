import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Big libraries get their own long-lived cache entries.
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (/node_modules\/(viem|@wagmi|ox|abitype|@noble|@scure|@adraffy|zustand|mipd|eventemitter3)\//.test(id)) return 'web3';
        },
      },
    },
  },
});
