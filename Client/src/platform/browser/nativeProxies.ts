// The browser platform's proxies (6.13c). There is no tunnel: the page talks
// to the server that served it. REST goes to the page's own origin, and
// LiveKit through the server's proxy path on the page's host.
import type { NativeProxies } from "../contracts/nativeProxies";

/** `ws:`/`wss:` to match the page, so a socket is as secure as the page. */
function socketScheme(): string {
  return location.protocol === "https:" ? "wss:" : "ws:";
}

export const nativeProxies: NativeProxies = {
  async ensureHttpProxy(host: string): Promise<string> {
    if (host.toLowerCase() !== location.host.toLowerCase()) {
      // i18n-exempt: diagnostic
      throw new Error("the browser client reaches only the server that served it");
    }
    return location.origin;
  },
  // The page's host is the only server, so there is nothing to record.
  setLiveKitServerHost: () => undefined,
  async resolveLiveKitUrl(proxyPath: string): Promise<string> {
    // A proxy path goes through the server; anything else is already a URL.
    return proxyPath.startsWith("/")
      ? `${socketScheme()}//${location.host}${proxyPath}`
      : proxyPath;
  },
  stopLiveKitProxy: () => undefined,
};
