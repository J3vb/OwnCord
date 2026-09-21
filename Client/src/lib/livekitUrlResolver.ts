// LiveKit URL resolver — extracted from livekitSession.ts.
// Owns URL resolution (direct vs TLS proxy) and the Rust-side TLS proxy
// lifecycle, through `platform/desktop`'s `nativeProxies` (B7-5), which holds
// the server host and the tunnel. The app has one LiveKit session, so one
// resolver.

import { desktop } from "../platform/desktop";

export class LiveKitUrlResolver {
  setServerHost(host: string | null): void {
    desktop.nativeProxies!.setLiveKitServerHost(host);
  }

  /** Resolve a LiveKit connection URL. Routes through the local Rust TLS
   *  proxy for remote servers (to handle self-signed certs), or returns
   *  the direct URL for local connections. */
  async resolve(proxyPath: string, directUrl?: string): Promise<string> {
    return desktop.nativeProxies!.resolveLiveKitUrl(proxyPath, directUrl);
  }

  /** Stop the Rust-side TLS proxy (fire-and-forget). */
  stopProxy(): void {
    desktop.nativeProxies!.stopLiveKitProxy();
  }
}
