/**
 * The connection banner's wiring: Use here, Retry, the store-backed status
 * subscription, the device's online/offline events and the server-restart
 * countdown. The page builds the banner element; this keeps it true.
 */
import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import type { WsClient } from "@lib/ws";
import { authStore } from "@stores/auth.store";
import { setSessionReplaced, uiStore } from "@stores/ui.store";
import { applyConnectionStatus, type ServerBannerControl } from "../server-rail/ServerBanner";

const log = createLogger("main-page");

export interface ConnectionBannerWiring {
  /** The page's banner; null once the page has torn it down. */
  readonly getBanner: () => ServerBannerControl | null;
  readonly ws: WsClient;
  readonly getHost: () => string;
  /** Runs each time the status turns "connected". */
  readonly onConnected: () => void;
}

/**
 * The device's own network fact, apart from the server's reachability: a LAN
 * server with no internet still answers `onLine`. `undefined` where the host
 * does not expose the API, so a notice never claims the internet is required.
 */
export function deviceNetworkOffline(): boolean | undefined {
  return typeof navigator.onLine === "boolean" ? !navigator.onLine : undefined;
}

/** Wires the banner to the connection state. Returns the teardown. */
export function wireConnectionBanner(w: ConnectionBannerWiring): () => void {
  // "Use here" takes the connection back: this device connects again and
  // the server displaces the other one (last connect wins). It serves both
  // a displaced socket (SESSION_REPLACED) and a wake reconnect the server
  // refused because another device held the session (ANOTHER_DEVICE_ACTIVE,
  // U4) — the two are the same user choice, so they share one prompt.
  const useHere = (): void => {
    const token = authStore.getState().token;
    if (token === null) return;
    setSessionReplaced(false);
    w.ws.connect({ host: w.getHost(), token }, { takeover: true });
  };

  // Retry is safe on a plain disconnect: connect() re-dials and the native
  // proxy re-validates the certificate, so a TOFU mismatch re-latches rather
  // than being bypassed. It also cancels any pending backoff attempt, so it
  // cannot race the reconnect loop.
  const retryConnection = (): void => {
    const token = authStore.getState().token;
    if (token === null) return;
    w.ws.connect({ host: w.getHost(), token });
  };

  // Signed-in-elsewhere outranks the connection status it leaves behind
  // ("disconnected"), so every banner refresh goes through here. The device's
  // own network fact stays apart from the server's reachability: a LAN server
  // with no internet still answers onLine, and `undefined` (host without the
  // API) never claims the internet is required.
  const syncBanner = (): void => {
    const banner = w.getBanner();
    if (banner === null) return;
    const state = uiStore.getState();
    if (state.sessionReplaced) banner.showSignedInElsewhere(useHere);
    else
      applyConnectionStatus(banner, state.connectionStatus, {
        offline: deviceNetworkOffline(),
        dialFailed: state.connectionDialFailed,
        onRetry: retryConnection,
      });
  };

  const unsubscribers: (() => void)[] = [];
  unsubscribers.push(uiStore.subscribeSelector((s) => s.sessionReplaced, syncBanner));
  unsubscribers.push(uiStore.subscribeSelector((s) => s.connectionDialFailed, syncBanner));

  // Losing or regaining the device's network only re-renders, so the banner
  // says the true thing immediately; the reconnect loop and Retry own
  // recovery. Only re-render while the socket is actually down — a network
  // flap during a live connection (a VPN toggle, a Wi-Fi flap) must not
  // route to `applyConnectionStatus("connected")` and clear an announced
  // server-restart countdown. Owned by a Disposable so the lifecycle guard
  // sees both listeners torn down with the page.
  const networkOwner = new Disposable();
  const syncBannerIfNotConnected = (): void => {
    if (uiStore.getState().connectionStatus !== "connected") syncBanner();
  };
  window.addEventListener("online", syncBannerIfNotConnected, { signal: networkOwner.signal });
  window.addEventListener("offline", syncBannerIfNotConnected, { signal: networkOwner.signal });

  // Banner reacts to the store-backed connection status (single source of
  // truth, docs/architecture/ux §3). "disconnected" keeps the banner visible
  // — a fatal drop navigates away via clearAuth, and anything short of that
  // must not leave a stale "Reconnecting..." on screen.
  unsubscribers.push(
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      (status) => {
        try {
          if (status === "connected") w.onConnected();
          syncBanner();
        } catch (err) {
          log.error("Connection status handler error", err);
        }
      },
    ),
  );

  // Synchronous initial sync: the selector subscription baselines on the
  // current value and only fires on change, so a MainPage mounted mid-outage
  // (status already "reconnecting") would otherwise never show the banner —
  // the whole retry cycle maps to the same 3-state value.
  syncBanner();

  const offRestart = w.ws.on("server_restart", (payload) => {
    try {
      // Every reason counts down: the session survives the restart
      // and ws.ts reconnects once the socket drops.
      const banner = w.getBanner();
      if (banner !== null) {
        if (payload.delay_seconds <= 0) {
          // A zero/negative delay is a cancel, not a countdown (e.g.
          // "update_aborted" correcting an earlier restart announcement
          // after the staged update failed to apply — the socket never
          // actually dropped). Re-sync to the real connection status
          // instead of letting showRestart's countdown fall straight
          // through to a permanent "Reconnecting..." banner.
          syncBanner();
        } else {
          banner.showRestart(payload.delay_seconds);
        }
      }
    } catch (err) {
      log.error("Server restart handler error", err);
    }
  });

  return () => {
    for (const off of unsubscribers) off();
    offRestart();
    networkOwner.destroy();
  };
}
