import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isTest = Boolean(process.env.VITEST);

export function asyncHooksPolyfillPlugin() {
  const stubPath = path.resolve(__dirname, "./src/lib/async-hooks-stub.ts");
  const routerPath = path.resolve(__dirname, "./src/router.tsx");
  return {
    name: "async-hooks-browser-polyfill",
    enforce: "pre" as const,
    resolveId(source: string, _importer?: string, options?: { ssr?: boolean }) {
      if (source === "#tanstack-router-entry") {
        return routerPath;
      }
      if (!options?.ssr && (source === "node:async_hooks" || source === "async_hooks")) {
        return stubPath;
      }
      return null;
    },
  };
}

export function serverBoundaryPlugin() {
  return {
    name: "server-only-boundary-guard",
    resolveId(source: string, importer?: string, options?: { ssr?: boolean }) {
      const isClient = !options?.ssr;
      if (isClient && importer) {
        const isServerOrTestImporter =
          importer.includes(".server.") ||
          importer.includes("/server/") ||
          importer.includes("/tests/") ||
          importer.includes(".test.") ||
          importer.includes(".spec.");

        if (!isServerOrTestImporter) {
          if (
            source === "web-push" ||
            source.includes("push-sender.server") ||
            source.endsWith(".server") ||
            source.endsWith(".server.ts") ||
            source.endsWith(".server.js")
          ) {
            throw new Error(
              `[Server Boundary Violation] Client module "${importer}" attempted to import server-only module or package "${source}".`
            );
          }
        }
      }
      return null;
    },
  };
}

export function removeUseClientDirectivePlugin() {
  return {
    name: "remove-use-client-directive",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (code.includes('"use client"') || code.includes("'use client'")) {
        return {
          code: code.replace(/(?:^|\n)\s*['"]use client['"];?\s*/g, "\n"),
          map: null,
        };
      }
      return null;
    },
  };
}

const onwarn = (warning: any, warn: any) => {
  if (
    warning.code === "MODULE_LEVEL_DIRECTIVE" ||
    warning.message?.includes('"use client"') ||
    warning.message?.includes("Module level directives")
  ) {
    return;
  }
  warn(warning);
};

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "#tanstack-router-entry": path.resolve(__dirname, "./src/router.tsx"),
      "node:async_hooks": path.resolve(__dirname, "./src/lib/async-hooks-stub.ts"),
      async_hooks: path.resolve(__dirname, "./src/lib/async-hooks-stub.ts"),
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
    asyncHooksPolyfillPlugin(),
    removeUseClientDirectivePlugin(),
    serverBoundaryPlugin(),
    tailwindcss(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    !isTest &&
      tanstackStart({
        autoCodeSplitting: false,
        server: { entry: "server" },
        client: { entry: "./src/client.tsx" },
      }),
    !isTest &&
      nitro({
        preset: process.env.NITRO_PRESET || (process.env.VERCEL ? "vercel" : "node-server"),
        devServer: {
          port: 3001,
          host: "0.0.0.0",
        },
        rollupConfig: {
          onwarn,
        },
        hooks: {
          "rollup:before"(_nitro: any, rollupConfig: any) {
            if (rollupConfig) {
              rollupConfig.onwarn = onwarn;
            }
          },
        },
      }),
    react(),
  ].filter(Boolean),
  build: {
    rollupOptions: {
      onwarn,
    },
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          onwarn,
        },
      },
    },
    ssr: {
      build: {
        rollupOptions: {
          onwarn,
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    cors: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
});

