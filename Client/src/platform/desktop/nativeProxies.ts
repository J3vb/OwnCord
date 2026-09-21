// The local loopback tunnels that let the webview talk to a self-signed
// server without ever accepting its certificate itself. Both halves are
// lifted verbatim (B7-5): the HTTP tunnel from `lib/httpProxy.ts`, and the
// LiveKit tunnel from `LiveKitUrlResolver` (`lib/livekitUrlResolver.ts`),
// whose instance fields become this module's state — the app has one LiveKit
// session, and the class there now delegates here.
import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import type { NativeProxies } from "../contracts/nativeProxies";

// --- HTTP ------------------------------------------------------------------
//
// The Rust `http_proxy` module runs one loopback TCP→TLS tunnel per remote
// host and pins the server certificate with the same trust-on-first-use store
// as the WebSocket proxy. REST calls go to http://127.0.0.1:{port} instead of
// https://{host} directly, so the webview never has to accept an invalid
// certificate and the bearer token never rides an unpinned TLS connection.

const httpLog = createLogger("http-proxy");

/** host → in-flight start so concurrent callers don't race the tunnel. */
const pending = new Map<string, Promise<string>>();

/**
 * Ensure a tunnel exists for `host` and return its loopback origin
 * (no trailing slash). Concurrency-safe per host.
 *
 * Always invokes start_http_proxy — never caches the resolved origin here.
 * Only the Rust side knows whether its listener is still alive: after 5
 * consecutive accept errors run_accept_loop deregisters itself so the next
 * start_http_proxy rebinds a fresh port (http_proxy.rs). A JS-side cache
 * would keep pointing every REST call at that dead tunnel until app restart.
 * The Rust reuse branch dedups an unchanged host cheaply, so the repeat
 * invoke is inexpensive — mirroring ensureLiveKitProxy below.
 */
async function ensureHttpProxy(host: string): Promise<string> {
  const inFlight = pending.get(host);
  if (inFlight) return inFlight;

  const start = (async () => {
    const port = await invoke<number>("start_http_proxy", { remoteHost: host });
    const origin = `http://127.0.0.1:${port}`;
    httpLog.debug("tunnel ready", { host, origin });
    return origin;
  })();

  pending.set(host, start);
  try {
    return await start;
  } finally {
    pending.delete(host);
  }
}

// --- LiveKit ---------------------------------------------------------------

const livekitLog = createLogger("livekitUrlResolver");

/** Cached port for the local LiveKit TLS proxy (Rust-side, for self-signed cert support). */
let proxyPort: number | null = null;
let serverHost: string | null = null;

/**
 * The recorded LiveKit proxy port. Production-unused but exported as the unit
 * tests' observability point: it was a `LiveKitUrlResolver` field they read.
 * @public
 */
export function getLiveKitProxyPort(): number | null {
  return proxyPort;
}

function setLiveKitServerHost(host: string | null): void {
  serverHost = host;
}

/** Start (or reuse) the Rust-side local TCP-to-TLS proxy for LiveKit.
 *
 *  Always invokes start_livekit_proxy — never cache the port here. Only the
 *  Rust side can compare the running proxy's TOFU pin against certs.json,
 *  so after the user accepts a rotated cert a JS port cache would keep
 *  every voice rejoin tunneling into the stale pin until logout. The Rust
 *  reuse branch dedups unchanged host+pin, so the repeat call is cheap.
 *
 *  Exported for the unit tests only: its null-host guard is unreachable from
 *  resolveLiveKitUrl(), which takes the passthrough branch for a null host.
 *  @public */
export async function ensureLiveKitProxy(): Promise<number> {
  if (serverHost === null) throw new Error("no server host for LiveKit proxy");
  // Ensure host:port format — default to 443 (standard HTTPS) when the
  // server is behind a reverse proxy. Without an explicit port, the Rust
  // proxy would default to 8443 which may not be exposed.
  // Handle IPv6: "[::1]:7880" has port, "[::1]" and bare "::1" do not.
  let hostWithPort: string;
  if (serverHost.startsWith("[")) {
    // Bracketed IPv6 — check for "]:port" suffix
    hostWithPort = serverHost.includes("]:") ? serverHost : `${serverHost}:443`;
  } else if ((serverHost.match(/:/g) ?? []).length > 1) {
    // Bare IPv6 (multiple colons) — wrap in brackets and add default port
    hostWithPort = `[${serverHost}]:443`;
  } else {
    hostWithPort = serverHost.includes(":") ? serverHost : `${serverHost}:443`;
  }
  proxyPort = await invoke<number>("start_livekit_proxy", {
    remoteHost: hostWithPort,
  });
  livekitLog.info("LiveKit TLS proxy started on localhost", { port: proxyPort });
  return proxyPort;
}

/** Resolve a LiveKit connection URL. Routes through the local Rust TLS
 *  proxy for remote servers (to handle self-signed certs), or returns
 *  the direct URL for local connections. */
async function resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string> {
  if (serverHost !== null) {
    // Extract hostname, handling IPv6 bracket notation (e.g. "[::1]:7880")
    // and bare IPv6 (e.g. "::1").
    let host: string;
    if (serverHost.startsWith("[")) {
      host = serverHost.slice(1, serverHost.indexOf("]"));
    } else if ((serverHost.match(/:/g) ?? []).length > 1) {
      // Bare IPv6 address (multiple colons, no brackets) — use as-is
      host = serverHost;
    } else {
      host = serverHost.split(":")[0] ?? "";
    }
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (isLocal && directUrl) {
      livekitLog.debug("LiveKit URL resolved via direct (local)", { url: directUrl });
      return directUrl;
    }
    if (proxyPath.startsWith("/")) {
      // Remote server: route through the local Rust TLS proxy so WebView2
      // doesn't reject self-signed certificates on the LiveKit signal WS.
      const port = await ensureLiveKitProxy();
      const resolved = `ws://127.0.0.1:${port}${proxyPath}`;
      livekitLog.debug("LiveKit URL resolved via TLS proxy", {
        url: resolved,
        remoteHost: serverHost,
      });
      return resolved;
    }
  }
  livekitLog.debug("LiveKit URL resolved as passthrough", { url: proxyPath });
  return proxyPath;
}

/** Stop the Rust-side TLS proxy (fire-and-forget). */
function stopLiveKitProxy(): void {
  // Drop the recorded port with the proxy it names. Nothing reads it back
  // (resolveLiveKitUrl() always re-invokes, deliberately — see
  // ensureLiveKitProxy), but leaving a dead port behind after cleanup means
  // any future reader inherits a value that no longer points at a running
  // proxy.
  proxyPort = null;
  invoke("stop_livekit_proxy").catch((err) => livekitLog.warn("Failed to stop LiveKit proxy", err));
}

export const nativeProxies: NativeProxies = {
  ensureHttpProxy,
  setLiveKitServerHost,
  resolveLiveKitUrl,
  stopLiveKitProxy,
};
