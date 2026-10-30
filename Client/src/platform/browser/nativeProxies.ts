// The browser platform's proxies. There is no tunnel: the page talks
// to the server that served it. REST goes to the page's own origin, and
// LiveKit through the server's proxy path on the page's host.
import type { NativeProxies } from "../contracts/nativeProxies";

/** `ws:`/`wss:` to match the page, so a socket is as secure as the page. */
function socketScheme(): string {
  return location.protocol === "https:" ? "wss:" : "ws:";
}

/** `host` as a URL authority (lower case, default port dropped), or null
 *  when it is not one. */
function authority(host: string): string | null {
  try {
    return new URL(`https://${host}`).host;
  } catch {
    return null;
  }
}

export const nativeProxies: NativeProxies = {
  async ensureHttpProxy(host: string): Promise<string> {
    const wanted = authority(host);
    if (wanted === null || wanted !== authority(location.host)) {
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
