import { defineConfig } from "vite";
import { resolve } from "path";

/**
 * Target-neutral config. Settings that exist only because the Tauri desktop
 * shell is the consumer live in `vite.config.desktop.ts`; nothing here may
 * assume a target. Plain `vite build` on this file is the non-desktop build.
 */
export default defineConfig({
  build: {
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Keep the ~1.3 MB LiveKit SDK in its own chunk, out of the entry.
        // Rolldown (Vite 8) only supports the function form of manualChunks.
        manualChunks(id) {
          if (id.includes("node_modules/livekit-client/")) return "livekit";
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@lib": resolve(import.meta.dirname, "src/lib"),
      "@stores": resolve(import.meta.dirname, "src/stores"),
      "@components": resolve(import.meta.dirname, "src/components"),
      "@pages": resolve(import.meta.dirname, "src/pages"),
      "@styles": resolve(import.meta.dirname, "src/styles"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
