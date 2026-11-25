/**
 * Which voice addresses a voice_token may name. The server sends the path of
 * its own LiveKit proxy (`/livekit/...`), which the client reaches on the
 * server it is signed in to; a local server may also name a loopback direct
 * address. Leaf module: the platform resolvers and the join path share it.
 */

/** A voice address the client does not connect to. The join that asked for it
 *  fails like any other failed join. */
export class LiveKitAddressError extends Error {
  constructor() {
    // i18n-exempt: diagnostic, logged by the join path and never rendered
    super("voice address is not the server's proxy path");
    this.name = "LiveKitAddressError";
  }
}

/** Whether `url` is a path on the signed-in server (the proxy path). */
export function isProxyPath(url: string): boolean {
  return url.startsWith("/");
}

/** True when `url` is a plain ws:/http: URL on a loopback host — exactly the
 *  LiveKit origins tauri.conf.json's connect-src allows. */
export function isLoopbackDirectUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      (protocol === "ws:" || protocol === "http:") &&
      (hostname === "localhost" || hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}
