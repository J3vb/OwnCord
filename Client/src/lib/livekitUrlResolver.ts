// LiveKit URL resolver — extracted from livekitSession.ts.
// Owns URL resolution (direct vs TLS proxy) and the Rust-side TLS proxy lifecycle.

import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";

const log = createLogger("livekitUrlResolver");

export class LiveKitUrlResolver {
  /** Cached port for the local LiveKit TLS proxy (Rust-side, for self-signed cert support). */
  private _proxyPort: number | null = null;
  private _serverHost: string | null = null;

  setServerHost(host: string | null): void {
    this._serverHost = host;
  }

  /** Start (or reuse) the Rust-side local TCP-to-TLS proxy for LiveKit.
   *
   *  Always invokes start_livekit_proxy — never cache the port here. Only the
   *  Rust side can compare the running proxy's TOFU pin against certs.json,
   *  so after the user accepts a rotated cert a JS port cache would keep
   *  every voice rejoin tunneling into the stale pin until logout. The Rust
   *  reuse branch dedups unchanged host+pin, so the repeat call is cheap. */
  private async ensureLiveKitProxy(): Promise<number> {
    if (this._serverHost === null) throw new Error("no server host for LiveKit proxy");
    // Ensure host:port format — default to 443 (standard HTTPS) when the
    // server is behind a reverse proxy. Without an explicit port, the Rust
    // proxy would default to 8443 which may not be exposed.
    // Handle IPv6: "[::1]:7880" has port, "[::1]" and bare "::1" do not.
    let hostWithPort: string;
    if (this._serverHost.startsWith("[")) {
      // Bracketed IPv6 — check for "]:port" suffix
      hostWithPort = this._serverHost.includes("]:") ? this._serverHost : `${this._serverHost}:443`;
    } else if ((this._serverHost.match(/:/g) ?? []).length > 1) {
      // Bare IPv6 (multiple colons) — wrap in brackets and add default port
      hostWithPort = `[${this._serverHost}]:443`;
    } else {
      hostWithPort = this._serverHost.includes(":") ? this._serverHost : `${this._serverHost}:443`;
    }
    this._proxyPort = await invoke<number>("start_livekit_proxy", {
      remoteHost: hostWithPort,
    });
    log.info("LiveKit TLS proxy started on localhost", { port: this._proxyPort });
    return this._proxyPort;
  }

  /** Resolve a LiveKit connection URL. Routes through the local Rust TLS
   *  proxy for remote servers (to handle self-signed certs), or returns
   *  the direct URL for local connections. */
  async resolve(proxyPath: string, directUrl?: string): Promise<string> {
    if (this._serverHost !== null) {
      // Extract hostname, handling IPv6 bracket notation (e.g. "[::1]:7880")
      // and bare IPv6 (e.g. "::1").
      let host: string;
      if (this._serverHost.startsWith("[")) {
        host = this._serverHost.slice(1, this._serverHost.indexOf("]"));
      } else if ((this._serverHost.match(/:/g) ?? []).length > 1) {
        // Bare IPv6 address (multiple colons, no brackets) — use as-is
        host = this._serverHost;
      } else {
        host = this._serverHost.split(":")[0] ?? "";
      }
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (isLocal && directUrl) {
        log.debug("LiveKit URL resolved via direct (local)", { url: directUrl });
        return directUrl;
      }
      if (proxyPath.startsWith("/")) {
        // Remote server: route through the local Rust TLS proxy so WebView2
        // doesn't reject self-signed certificates on the LiveKit signal WS.
        const port = await this.ensureLiveKitProxy();
        const resolved = `ws://127.0.0.1:${port}${proxyPath}`;
        log.debug("LiveKit URL resolved via TLS proxy", {
          url: resolved,
          remoteHost: this._serverHost,
        });
        return resolved;
      }
    }
    log.debug("LiveKit URL resolved as passthrough", { url: proxyPath });
    return proxyPath;
  }

  /** Stop the Rust-side TLS proxy (fire-and-forget). */
  stopProxy(): void {
    // Drop the recorded port with the proxy it names. Nothing reads it back
    // (resolve() always re-invokes, deliberately — see ensureLiveKitProxy), but
    // leaving a dead port behind after cleanup means any future reader inherits
    // a value that no longer points at a running proxy.
    this._proxyPort = null;
    invoke("stop_livekit_proxy").catch((err) => log.warn("Failed to stop LiveKit proxy", err));
  }
}
