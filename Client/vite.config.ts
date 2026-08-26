import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

/** Strip crossorigin attributes — Tauri serves via custom protocol. */
function stripCrossOrigin(): Plugin {
  return {
    name: "strip-crossorigin",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin/g, "");
    },
  };
}

export default defineConfig({
  plugins: [stripCrossOrigin()],
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
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Never watch the Rust tree. `tauri dev` runs Vite as its
      // `beforeDevCommand`, so without this the watcher picks up
      // `src-tauri/target/` and dies with EBUSY the moment cargo writes the
      // output DLL on Windows — taking the whole dev session with it. Tauri
      // already watches `src-tauri` itself for rebuilds.
      ignored: ["**/src-tauri/**"],
    },
  },
});
