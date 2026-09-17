// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: {
    preset: "node-server",
  },
  vite: {
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' || warning.message?.includes('"use client"')) {
            return;
          }
          warn(warning);
        },
      },
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
    },
    plugins: [
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: null, // we register manually via a guarded wrapper (src/lib/pwa.ts)
        devOptions: { enabled: false }, // never emit an SW in dev / Lovable preview
        filename: "sw.js",
        includeAssets: ["favicon.ico", "robots.txt"],
        manifest: {
          name: "Alpha",
          short_name: "Alpha",
          description: "Alpha — your hyper-intelligent AI companion.",
          display: "standalone",
          background_color: "#020617",
          theme_color: "#38bdf8",
          start_url: "/",
          scope: "/",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,woff2}"],
          navigateFallback: "/",
          navigateFallbackDenylist: [/^\/~oauth/, /^\/api\//],
          runtimeCaching: [
            {
              // HTML → NetworkFirst so new deploys are picked up
              urlPattern: ({ request }) => request.mode === "navigate",
              handler: "NetworkFirst",
              options: { cacheName: "alpha-html", networkTimeoutSeconds: 4 },
            },
            {
              // Same-origin hashed assets → CacheFirst
              urlPattern: ({ url, request }) =>
                url.origin === self.location.origin &&
                (request.destination === "script" || request.destination === "style" || request.destination === "image" || request.destination === "font"),
              handler: "CacheFirst",
              options: {
                cacheName: "alpha-assets",
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
