import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon.svg', 'icon-maskable.svg'],
      manifest: {
        name: 'Tally — shared household checklist',
        short_name: 'Tally',
        description: 'Tick it off once, everyone knows it is done.',
        theme_color: '#161826',
        background_color: '#161826',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The API must never be served from cache: a stale list would show the
        // cat as unfed when someone already did it. Offline reads come from the
        // app's own state, not from a cached response.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
