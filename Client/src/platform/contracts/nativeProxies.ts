/**
 * The local loopback tunnels that let the webview talk to a self-signed
 * server without ever accepting its certificate itself.
 *
 * `ensureHttpProxy` has the exact signature of `lib/httpProxy.ts`'s export;
 * `setLiveKitServerHost`/`resolveLiveKitUrl`/`stopLiveKitProxy` mirror
 * `LiveKitUrlResolver`'s `setServerHost`/`resolve`/`stopProxy` one-for-one
 * (`lib/livekitUrlResolver.ts`). Both tunnels live in
 * `platform/desktop/nativeProxies.ts` since B7-5, which holds the LiveKit
 * server host the class used to; the `lib/` names stay as their callers'
 * handles.
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
