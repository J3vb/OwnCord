// Step 2.15 — WebSocket Client
// Uses Tauri IPC (ws_connect/ws_send/ws_disconnect commands + events)
// to proxy WSS through Rust, bypassing self-signed cert issues in webview.
//
// This file wires one client together and owns the connection attempt
// (connect/disconnect and the generation checks around them). The concerns
// live in net/ws/: auth frame, inbound frames, transport state, reconnect,
// liveness, gap resume and sending. They all take the client's WsState.

import type { ServerMessage, ClientMessage } from "./types";
import { desktop } from "../platform/desktop";
import type { SocketConnection } from "../platform/contracts/socket";
import { createLogger } from "./logger";
import { recordEvent } from "./diagnostics/eventSink";
import { normalizeHostForCertCompare } from "./net/hostNormalize";
import { eventHost } from "./net/ws/authFrame";
import { bumpGeneration, currentGeneration } from "./net/ws/generation";
import { stopHeartbeat, stopLiveness } from "./net/ws/wsLiveness";
import { handleMessage } from "./net/ws/wsInbound";
import { cancelGapResume, cancelReconnect, stopWakeListeners } from "./net/ws/wsTimers";
import { pingTransport, sendMessage } from "./net/ws/wsSend";
import {
  createWsState,
  disconnectProxy,
  setState,
  type ReconnectDependencies,
  type WsState,
} from "./net/ws/wsState";
import { handleCertFirstUse, handleCertMismatch, handleTransportState } from "./net/ws/wsTransport";
import {
  type CertFirstUseListener,
  type CertMismatchListener,
  type ConnectionState,
  type WsClientConfig,
  type WsListener,
  wsUrlFor,
} from "./wsConfig";
export { setActiveChannelProvider, setIdentityKeyProvider } from "./net/ws/authFrame";
export {
  toConnectionStatus,
  parseStoredFingerprint,
  CERT_NOT_ACCEPTED,
  isCertDeclined,
  PREAUTH_CONNECT_TIMEOUT_MS,
  PREAUTH_BUSY_CAP_MS,
  bracketBareIPv6Host,
} from "./wsConfig";
export type {
  ConnectionState,
  WsListener,
  CertTofuEvent,
  CertMismatchListener,
  CertFirstUseListener,
  WsClientConfig,
} from "./wsConfig";
/** Normalize a host for comparison against the Rust proxies' cert-tofu event
 *  host, mirroring `tofu::cert_store_key`'s trailing-":443" strip, portless
 *  bracketed-IPv6 unwrap and lowercasing (src-tauri/src/tofu.rs). Profile/
 *  config hosts are stored verbatim (e.g. "Example.COM:443", or the
 *  bracketed "[2001:db8::1]" that hostValidation.ts accepts), but the
 *  proxies always emit the normalized form, so an un-normalized comparison
 *  here would silently miss the match. Order matters and matches the Rust:
 *  ":443" comes off first, so "[::1]:443" unwraps too, while a non-default
 *  port keeps its brackets as its own distinct key.
 *
 *  The ":443" strip only applies when what's left is unambiguously a host
 *  (no remaining colon) or a bracketed IPv6 literal (ends in "]", as in
 *  "[::1]:443"). Without this guard, a BARE IPv6 literal whose final hextet
 *  is "443" — e.g. "fd00::443" — would have that hextet eaten as if it were
 *  a port, truncating it to "fd00:" and missing the cert_store_key it's
 *  compared against. */
export { normalizeHostForCertCompare };

const log = createLogger("ws");

export function createWsClient({
  random = Math.random,
  clock = globalThis,
}: ReconnectDependencies = {}) {
  const transport: SocketConnection = desktop.socket.create();
  const s: WsState = createWsState(transport, random, clock, (cfg) => connect(cfg));

  // The transport's reports, for the lifetime of this client. Each one is a
  // thin forwarder into the app-side logic that already handled the matching
  // native event.
  transport.onMessage((raw) => handleMessage(s, raw));
  transport.onStateChange((next, retryHint) => handleTransportState(s, next, retryHint));
  transport.onCertFirstUse((raw) => handleCertFirstUse(s, raw));
  transport.onCertMismatch((raw) => handleCertMismatch(s, raw));

  async function connect(cfg: WsClientConfig, takeover = false): Promise<void> {
    if (s.state === "connecting" || s.state === "authenticating") {
      recordEvent("ws.superseded", {
        generation: currentGeneration(),
        by_generation: currentGeneration() + 1,
      });
    }
    // Captured so a disconnect() landing mid-attempt can be detected on resume
    // — disconnect() bumps the generation too, so a mismatch here means this
    // attempt was cancelled.
    const gen = bumpGeneration();
    s.config = cfg;
    s.intentionalClose = false;
    // Only an explicit takeover ("Use here") drops the wake marker. Any
    // other connect — the reconnect loop, Retry, a certificate re-dial — keeps
    // it, so the server can still refuse a dial that would displace another
    // device.
    if (takeover) s.pendingWake = false;
    s.lastActivityAt = Date.now();
    // Belt-and-braces: a fresh connect (even one not routed through
    // disconnect(), e.g. a suppressed-modal cert latch from an unrelated
    // host) must not inherit a stale block from a previous connection.
    s.certMismatchBlock = false;
    s.connectFailureCode = null;
    s.restartRedialAt = null;
    s.busyRetryAfterMs = undefined;
    s.busyHold = false;
    cancelReconnect(s);
    cancelGapResume(s);
    stopLiveness(s);

    setState(s, "connecting");
    s.attemptStartedAt = Date.now();
    recordEvent("ws.connecting", {
      generation: gen,
      attempt: s.reconnectAttempt,
      host: eventHost(cfg.host),
    });

    const url = wsUrlFor(cfg.host);
    log.info("WebSocket connecting", {
      url,
      isReconnect: s.reconnectAttempt > 0,
      attempt: s.reconnectAttempt,
    });

    try {
      await transport.connect({
        url,
        token: cfg.token,
        maxReconnectDelayMs: cfg.maxReconnectDelayMs,
        maxMessageSizeBytes: cfg.maxMessageSizeBytes,
      });
    } catch (err) {
      if (gen !== currentGeneration()) {
        // A disconnect() (or a newer connect()) landed while the transport was
        // dialling — this failure belongs to a superseded attempt.
        recordEvent("ws.stale_event", { generation: gen, live_generation: currentGeneration() });
        return;
      }
      log.error("Tauri APIs not available, cannot connect WebSocket", err);
      s.proxyOpen = false;
      setState(s, "disconnected");
    }
  }

  function disconnect(): void {
    // Invalidate any connect() suspended mid-await (e.g. cancelled
    // auto-login, logout racing a fresh connect) so it notices on resume
    // instead of finishing setup and opening the very socket this teardown
    // was meant to prevent. See the transport's own generation guards and
    // connect()'s gen checks.
    bumpGeneration();
    s.intentionalClose = true;
    log.info("WebSocket disconnecting (intentional)", { host: s.config?.host ?? "unknown" });
    s.certMismatchBlock = false;
    s.pendingWake = false;
    s.restartRedialAt = null;
    s.busyRetryAfterMs = undefined;
    s.busyHold = false;
    cancelReconnect(s);
    cancelGapResume(s);
    stopHeartbeat(s);
    stopLiveness(s);
    stopWakeListeners(s);
    s.proxyOpen = false;
    void disconnectProxy(s);
    setState(s, "disconnected");
    s.config = null;
    // Reset lastSeq — disconnect() is only called for intentional close
    // (logout). Automatic reconnects go through scheduleReconnect() which
    // preserves lastSeq for server-side event replay.
    s.lastSeq = 0;
    // Reset the backoff exponent too — a session abandoned mid-reconnect must
    // not carry its attempt count (and therefore its backoff ceiling) into
    // the next login's first retry.
    s.reconnectAttempt = 0;
  }

  return {
    /** `takeover` is the user's informed choice to take the session back
     * from another device ("Use here"); it drops any pending wake marker. */
    connect(cfg: WsClientConfig, opts?: { readonly takeover?: boolean }): void {
      void connect(cfg, opts?.takeover === true);
    },

    disconnect,

    /** Send a heartbeat and require a fresh pong on this authenticated socket.
     * Pongs are uncorrelated, so this proves liveness, not an RTT measurement. */
    ping(signal: AbortSignal, timeoutMs = 5000): Promise<void> {
      return pingTransport(s, signal, timeoutMs);
    },

    send(msg: ClientMessage): string {
      return sendMessage(s, msg);
    },

    on<T extends ServerMessage["type"]>(type: T, listener: WsListener<T>): () => void {
      if (!s.listeners.has(type)) {
        s.listeners.set(type, new Set());
      }
      const set = s.listeners.get(type)!;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },

    onStateChange(listener: (state: ConnectionState) => void): () => void {
      s.stateListeners.add(listener);
      return () => s.stateListeners.delete(listener);
    },

    /**
     * Register a listener for local transport send failures (proxy not open,
     * outbound channel full/closed). Called with the envelope id returned by
     * send() and an error code ("OFFLINE" | "NETWORK"). Heartbeat pings and
     * other id-less raw sends never fire it.
     */
    onSendFailure(listener: (id: string, code: string) => void): () => void {
      s.sendFailureListeners.add(listener);
      return () => s.sendFailureListeners.delete(listener);
    },

    /**
     * Register the global cert-tofu event listener. Idempotent. Call once at app
     * bootstrap (before the connect page's health checks) so first-use and
     * mismatch events are received even before a WS connection exists.
     */
    async startCertListener(): Promise<void> {
      await transport.startCertListener();
    },

    /** Register a listener for TOFU first-use confirmation events (F4/F8). */
    onCertFirstUse(listener: CertFirstUseListener): () => void {
      s.certFirstUseListeners.add(listener);
      return () => s.certFirstUseListeners.delete(listener);
    },

    /** Register a listener for SERVER_BUSY refusals (P5-S04). */
    onServerBusy(listener: () => void): () => void {
      s.serverBusyListeners.add(listener);
      return () => s.serverBusyListeners.delete(listener);
    },

    /** Register a listener for a ready or auth_ok of the wrong shape. */
    onHandshakeFault(listener: () => void): () => void {
      s.handshakeFaultListeners.add(listener);
      return () => s.handshakeFaultListeners.delete(listener);
    },

    /** Register a listener for TOFU certificate mismatch events. */
    onCertMismatch(listener: CertMismatchListener): () => void {
      s.certMismatchListeners.add(listener);
      return () => s.certMismatchListeners.delete(listener);
    },

    /**
     * Accept a changed certificate fingerprint for a host.
     * Call after the user acknowledges a cert mismatch warning,
     * then reconnect. Clears the mismatch latch whether or not the native
     * command accepted the fingerprint, so a decline cannot block reconnect.
     */
    async acceptCertFingerprint(host: string, fingerprint: string): Promise<void> {
      try {
        await transport.acceptCertificate(host, fingerprint);
      } finally {
        s.certMismatchBlock = false;
      }
    },

    getState(): ConnectionState {
      return s.state;
    },

    /** The distinct failure code from the most recent rejected connect, when
     *  the transport reported one (a certificate failure carries
     *  `TLS_CERT_UNVERIFIED`); null otherwise. Read by the pre-auth deadline so
     *  it can name a certificate failure instead of calling it unreachable. */
    getConnectFailureCode(): string | null {
      return s.connectFailureCode;
    },

    /** @internal for testing */
    _getWs(): WebSocket | null {
      return null;
    },
  };
}

export type WsClient = ReturnType<typeof createWsClient>;
