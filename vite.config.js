import { defineConfig, loadEnv } from 'vite';

// Social previews need absolute URLs: SITE_URL (e.g. https://voxelraid.xyz) fills %SITE_URL% in index.html.
const siteUrl = (mode) => ({
  name: 'site-url',
  transformIndexHtml: (html) =>
    html.replaceAll('%SITE_URL%', (loadEnv(mode, process.cwd(), '').SITE_URL ?? '').replace(/\/$/, '')),
});

export default defineConfig(({ mode }) => ({
  plugins: [siteUrl(mode)],
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
          if (/node_modules\/(viem|@wagmi|ox|abitype|@noble|@scure|@adraffy|zustand|mipd|eventemitter3)\//.test(id))
            return 'web3';
        },
      },
    },
  },
}));
