/**
 * cert-reconnect — resume a WS connection after the user accepts a rotated
 * TLS certificate fingerprint (TOFU mismatch flow).
 *
 * Extracted out of main.ts, which has no unit-test seam of its own (it wires
 * the DOM, router and stores together at startup and is exercised at the
 * e2e level — see vitest.config.ts's coverage excludes) so this one piece of
 * retry logic can be tested directly.
 */

export interface CertReconnectWs {
  connect(cfg: { readonly host: string; readonly token: string }): void;
  onStateChange(listener: (state: string) => void): () => void;
}

export interface CertReconnectRouter {
  getCurrentPage(): string;
  navigate(page: string): void;
}

/**
 * Reconnect after the user accepts a rotated certificate fingerprint.
 *
 * wirePostAuth's own onStateChange handler unsubscribes itself the moment it
 * sees "disconnected" (so a later transition can't fire it a second time) —
 * and the mismatch that triggered this retry is exactly the "disconnected"
 * transition that did so. A bare `ws.connect()` here would therefore
 * reconnect into a page with nothing left listening to leave the connect
 * screen. Re-register a one-shot navigator first, unless the app already
 * reached "main" (mismatch arrived after login, socket already live there).
 */
export function reconnectAfterCertAccept(
  ws: CertReconnectWs,
  router: CertReconnectRouter,
  host: string,
  token: string,
): void {
  if (router.getCurrentPage() !== "main") {
    const unsub = ws.onStateChange((state) => {
      if (state === "connected") {
        unsub();
        router.navigate("main");
      }
    });
  }
  ws.connect({ host, token });
}
