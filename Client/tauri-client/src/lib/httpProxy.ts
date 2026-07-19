// Client-side helper for the Rust HTTP TOFU proxy (closes audit A-2026-07-02).
//
// The Rust `http_proxy` module runs one loopback TCP→TLS tunnel per remote
// host and pins the server certificate with the same trust-on-first-use store
// as the WebSocket proxy. REST calls go to http://127.0.0.1:{port} instead of
// https://{host} directly, so the webview never has to accept an invalid
// certificate and the bearer token never rides an unpinned TLS connection.
//
// This module maps a remote host ("host" or "host:port") to its loopback
// origin ("http://127.0.0.1:{port}"), caching per host and de-duplicating
// concurrent starts so parallel requests share one tunnel.

import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "./logger";

const log = createLogger("http-proxy");

/** host → resolved loopback origin (e.g. "http://127.0.0.1:49812"). */
const origins = new Map<string, string>();
/** host → in-flight start so concurrent callers don't race the tunnel. */
const pending = new Map<string, Promise<string>>();

/**
 * Ensure a tunnel exists for `host` and return its loopback origin
 * (no trailing slash). Idempotent and concurrency-safe per host.
 */
export async function ensureHttpProxy(host: string): Promise<string> {
  const cached = origins.get(host);
  if (cached) return cached;

  const inFlight = pending.get(host);
  if (inFlight) return inFlight;

  const start = (async () => {
    const port = await invoke<number>("start_http_proxy", { remoteHost: host });
    const origin = `http://127.0.0.1:${port}`;
    origins.set(host, origin);
    log.debug("tunnel ready", { host, origin });
    return origin;
  })();

  pending.set(host, start);
  try {
    return await start;
  } finally {
    pending.delete(host);
  }
}

/** Stop the tunnel for `host` and drop its cached origin (best-effort). */
export async function stopHttpProxy(host: string): Promise<void> {
  origins.delete(host);
  pending.delete(host);
  try {
    await invoke("stop_http_proxy", { remoteHost: host });
  } catch (err) {
    log.debug("stop_http_proxy failed (ignored)", { host, error: String(err) });
  }
}
