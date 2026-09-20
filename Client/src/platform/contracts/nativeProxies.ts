/**
 * The local loopback tunnels that let the webview talk to a self-signed
 * server without ever accepting its certificate itself.
 *
 * Seam for `ensureHttpProxy` — `lib/httpProxy.ts` exports it already, and the
 * contract method below has that function's exact signature. The LiveKit
 * half is no-seam: `LiveKitUrlResolver` (`lib/livekitUrlResolver.ts`) is a
 * class, not an exported function, so `setLiveKitServerHost`/
 * `resolveLiveKitUrl`/`stopLiveKitProxy` mirror its `setServerHost`/
 * `resolve`/`stopProxy` methods one-for-one without a suite yet; the suite
 * lands with the seam in B7-5.
 */
export interface NativeProxies {
  /** Ensure a tunnel exists for `host` and return its loopback origin
   *  (no trailing slash). */
  ensureHttpProxy(host: string): Promise<string>;
  /** Set the server host LiveKit connections should be tunneled for, or null
   *  to stop tunneling. */
  setLiveKitServerHost(host: string | null): void;
  /** Resolve a LiveKit connection URL, routing through a local tunnel for a
   *  remote server or returning `directUrl` unchanged for a local one. */
  resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string>;
  /** Stop the LiveKit tunnel (fire-and-forget). */
  stopLiveKitProxy(): void;
}
