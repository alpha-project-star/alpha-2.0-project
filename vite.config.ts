import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

const isTest = Boolean(process.env.VITEST);

export default defineConfig({
  resolve: {
    alias: {
      "@": "/src",
    },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  plugins: [
    tailwindcss(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    !isTest &&
      tanstackStart({
        server: { entry: "server" },
      }),
    !isTest &&
      nitro({
        preset: "node-server",
      }),
    react(),
  ].filter(Boolean),
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
});

