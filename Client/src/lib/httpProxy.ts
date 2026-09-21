// Client-side helper for the Rust HTTP TOFU proxy (closes audit A-2026-07-02).
//
// Maps a remote host ("host" or "host:port") to its loopback origin
// ("http://127.0.0.1:{port}"), de-duplicating concurrent starts so parallel
// requests share one tunnel. The tunnel itself is `platform/desktop`'s
// `nativeProxies` (B7-5); this export stays where its callers import it.

import { desktop } from "../platform/desktop";

/**
 * Ensure a tunnel exists for `host` and return its loopback origin
 * (no trailing slash). Concurrency-safe per host.
 */
export async function ensureHttpProxy(host: string): Promise<string> {
  return desktop.nativeProxies.ensureHttpProxy(host);
}
