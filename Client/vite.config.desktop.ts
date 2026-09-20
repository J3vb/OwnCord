import { defineConfig, mergeConfig, type Plugin } from "vite";
import shared from "./vite.config";

/**
 * Desktop (Tauri) overlay. Everything in this file exists because Tauri is the
 * consumer — the shared `vite.config.ts` must stay buildable for a target that
 * is not Tauri, so a setting that only makes sense here belongs here.
 */

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

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [stripCrossOrigin()],
    server: {
      // `tauri dev --host <ip>` exports TAURI_DEV_HOST so a phone or another
      // machine on the LAN can reach the dev server. The HMR socket then has
      // to bind that same host on a port of its own, because the default
      // client-side HMR URL resolves to the page's origin, which is the LAN
      // address rather than localhost.
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
  }),
);
