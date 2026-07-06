import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// The desktop app reuses the server repo's client modules (device link, turns,
// credentials, pairing) as TypeScript source. Only the main process may import
// them: `@sandi-server/*` is the alias app code uses, and `@/*` exists so the
// server files' own internal imports keep resolving once they are pulled into
// the main bundle. The renderer configs deliberately omit both aliases, so a
// renderer import of server code fails the build instead of dragging node:http
// into a browser context.
const serverSrc = resolve(import.meta.dirname, "../src");
const shared = resolve(import.meta.dirname, "src/shared");
const repoAssets = resolve(import.meta.dirname, "../assets");

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@sandi-server": serverSrc,
        "@": serverSrc,
        "@shared": shared,
      },
    },
    build: {
      // Bundle everything (server source and zod included) so the packaged app
      // is self-contained and there is exactly one zod instance at runtime.
      rollupOptions: {
        output: { format: "es" },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        "@shared": shared,
      },
    },
    build: {
      rollupOptions: {
        input: {
          pet: resolve(import.meta.dirname, "src/preload/pet-preload.ts"),
          chat: resolve(import.meta.dirname, "src/preload/chat-preload.ts"),
        },
        // Sandboxed preload scripts must be CommonJS; Electron refuses ESM
        // preloads when the renderer sandbox is on.
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": shared,
        "@assets": repoAssets,
      },
    },
    server: {
      fs: {
        // The spritesheets live in the repo's shared assets/ directory, one
        // level above the app package, so the dev server must be allowed out.
        allow: [resolve(import.meta.dirname, "..")],
      },
    },
    build: {
      rollupOptions: {
        input: {
          pet: resolve(import.meta.dirname, "src/renderer/pet/index.html"),
          chat: resolve(import.meta.dirname, "src/renderer/chat/index.html"),
        },
      },
    },
  },
});
