import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
// Phase B Step 6 — Solid.js incremental migration. The plugin compiles
// JSX/TSX files anywhere under src/components/solid/ to direct DOM ops, while
// the rest of the vanilla codebase keeps building unchanged. The plugin is a
// no-op for files that don't contain Solid syntax.
import solidPlugin from "vite-plugin-solid";

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
  plugins: [
    // Solid first so its JSX transform runs before any other transforms.
    solidPlugin({
      include: ["src/components/solid/**/*.{ts,tsx,js,jsx}"],
    }),
    stripCrossOrigin(),
  ],
  build: {
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
  },
  resolve: {
    alias: {
      "@lib": resolve(__dirname, "src/lib"),
      "@stores": resolve(__dirname, "src/stores"),
      "@components": resolve(__dirname, "src/components"),
      "@pages": resolve(__dirname, "src/pages"),
      "@styles": resolve(__dirname, "src/styles"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
  },
});
