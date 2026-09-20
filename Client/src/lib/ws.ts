// Step 2.15 — WebSocket Client
// Uses Tauri IPC (ws_connect/ws_send/ws_disconnect commands + events)
// to proxy WSS through Rust, bypassing self-signed cert issues in webview.

import type { ServerMessage, ClientMessage } from "./types";
import { createSocketTransport, wsUrlFor, bracketBareIPv6Host } from "../platform/desktop/socket";
import type { DesktopSocketTransport } from "../platform/desktop/socket";
import type { SocketConnectionState } from "../platform/contracts/socket";
import { createLogger } from "./logger";
import { PROTOCOL_EPOCH } from "./protocolTypes";

const log = createLogger("ws");

/** Monotonic generation counter — incremented on each connect() to invalidate
 *  stale event listeners from a previous connection attempt. */
let wsGeneration = 0;

export type ConnectionState =
  "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting";

/** The UX-facing 3-state status stored in ui.store.connectionStatus. */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * Collapse the internal 5-state machine into the UX-facing status.
 * "connecting"/"authenticating" map to "reconnecting" because a reconnect
 * cycle passes through them (reconnecting → connecting → authenticating →
 * connected); mapping them to "disconnected" would flap the banner mid-retry.
 */
export function toConnectionStatus(state: ConnectionState): ConnectionStatus {
  switch (state) {
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    default:
      return "reconnecting";
  }
}

export type WsListener<T extends ServerMessage["type"]> = (
  payload: Extract<ServerMessage, { type: T }>["payload"],
  id?: string,
) => void;

/** TOFU certificate event emitted by the Rust proxies (http / ws).
 *  - "first_use": no pin yet — the proxy REJECTED the connection; the user must
 *    confirm this fingerprint (acceptCertFingerprint) before anything is sent.
 *  - "trusted": pin matches — proceed.
 *  - "mismatch": pin differs — reject (possible MITM or cert rotation). */
export interface CertTofuEvent {
  readonly host: string;
  readonly fingerprint: string;
  readonly status: "first_use" | "trusted" | "mismatch";
  readonly message?: string;
  readonly storedFingerprint?: string;
}

/** Parse the stored fingerprint from the Rust cert-tofu message string. */
export function parseStoredFingerprint(message?: string): string | undefined {
  if (!message) return undefined;
  const match = /Stored:\s+(\S+)/.exec(message);
  return match?.[1];
}

export type CertMismatchListener = (event: CertTofuEvent) => void;
export type CertFirstUseListener = (event: CertTofuEvent) => void;

export interface WsClientConfig {
  readonly host: string;
  readonly token: string;
  readonly maxReconnectDelayMs?: number;
  readonly maxMessageSizeBytes?: number;
}

/**
 * Supplies the channel the user currently has open, so the auth frame can
 * declare it on a resume.
 *
 * Registered rather than imported: ws.ts is the transport and deliberately
 * depends on nothing but types and the logger, which is what lets the tests
 * drive it with minimal mocks.
 *
 * Without this the resumed connection holds no ChannelTopic subscription until
 * the post-auth_ok `channel_focus` round trip completes, and every message
 * broadcast to that channel in the meantime is lost with no way to ask for it
 * back (the client only reports max(seq)). The server still READ-gates the id
 * before honouring it, and `channel_focus` is still sent on auth_ok — this
 * only shrinks the window to zero.
 */
let activeChannelProvider: (() => number | null) | null = null;

export function setActiveChannelProvider(fn: (() => number | null) | null): void {
  activeChannelProvider = fn;
}

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_MAX_MESSAGE_SIZE = 1_048_576; // 1MB
const HEARTBEAT_INTERVAL_MS = 30_000;

function uuid(): string {
  return crypto.randomUUID();
}

/** Normalize a host for comparison against the Rust proxies' cert-tofu event
 *  host, mirroring `tofu::cert_store_key`'s trailing-":443" strip, portless
 *  bracketed-IPv6 unwrap and lowercasing (src-tauri/src/tofu.rs). Profile/
 *  config hosts are stored verbatim (e.g. "Example.COM:443", or the
 *  bracketed "[2001:db8::1]" that hostValidation.ts accepts), but the
 *  proxies always emit the normalized form, so an un-normalized comparison
 *  here would silently miss the match. Order matters and matches the Rust:
 *  ":443" comes off first, so "[::1]:443" unwraps too, while a non-default
 *  port keeps its brackets as its own distinct key (OC-0163).
 *
 *  The ":443" strip only applies when what's left is unambiguously a host
 *  (no remaining colon) or a bracketed IPv6 literal (ends in "]", as in
 *  "[::1]:443"). Without this guard, a BARE IPv6 literal whose final hextet
 *  is "443" — e.g. "fd00::443" — would have that hextet eaten as if it were
 *  a port, truncating it to "fd00:" and missing the cert_store_key it's
 *  compared against (OC-0215/OC-0417). */
export function normalizeHostForCertCompare(host: string): string {
  let stripped = host;
  if (host.endsWith(":443")) {
    const rest = host.slice(0, -":443".length);
    if (!rest.includes(":") || rest.endsWith("]")) stripped = rest;
  }
  return stripped.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

// The native socket transport, and the URL helpers it owns, live behind the
// `SocketTransport` contract in `platform/desktop/socket.ts` (B7-4). This
// module keeps everything above that seam: the connection state machine, the
// reconnect policy, the heartbeat, frame parsing and the send-failure codes.
export { bracketBareIPv6Host };

export function createWsClient() {
  // One transport per client: the certificate listener it registers is
  // app-lifetime state, and a second client (a fresh login, a test) must not
  // inherit a registration the first one made.
  const transport: DesktopSocketTransport = createSocketTransport();
  let config: WsClientConfig | null = null;
  let state: ConnectionState = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let intentionalClose = false;
  let certMismatchBlock = false; // blocks reconnect on TOFU mismatch
  // Mirror of the proxy's own open/closed state, kept here because the
  // send-failure codes below are decided on this side of the seam.
  let proxyOpen = false;
  let lastSeq = 0;

  // The transport's reports, for the lifetime of this client. Each one is a
  // thin forwarder into the app-side logic that already handled the matching
  // native event.
  transport.onMessage(handleMessage);
  transport.onStateChange(handleTransportState);
  transport.onCertFirstUse(handleCertFirstUse);
  transport.onCertMismatch(handleCertMismatch);

  // Type-safe listener registry
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();

  // State change listeners
  const stateListeners = new Set<(state: ConnectionState) => void>();
  // Diagnostic probes observe a fresh server heartbeat; pongs carry no id.
  const pongListeners = new Set<() => void>();

  // Local send-failure listeners (transport level: proxy not open, outbound
  // channel full/closed). Notified with the envelope id so the dispatcher can
  // fail the matching optimistic row instead of dropping the send silently.
  const sendFailureListeners = new Set<(id: string, code: string) => void>();

  // TOFU cert mismatch listeners
  const certMismatchListeners = new Set<CertMismatchListener>();

  // TOFU first-use confirmation listeners (F4/F8)
  const certFirstUseListeners = new Set<CertFirstUseListener>();

  function setState(newState: ConnectionState): void {
    if (state !== newState) {
      state = newState;
      for (const listener of stateListeners) {
        try {
          listener(state);
        } catch (err) {
          log.error("State listener error", err);
        }
      }
    }
  }

  function getReconnectDelay(): number {
    const maxDelay = config?.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY;
    return Math.min(1000 * Math.pow(2, reconnectAttempt), maxDelay);
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (proxyOpen) {
        try {
          sendRaw(JSON.stringify({ type: "ping", payload: {} }));
        } catch (err) {
          log.warn("Heartbeat ping send failed", err);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose || certMismatchBlock || !config) return;
    const delay = getReconnectDelay();
    log.info("WebSocket reconnecting", {
      delayMs: delay,
      attempt: reconnectAttempt + 1,
      host: config?.host ?? "unknown",
      lastSeq,
    });
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectAttempt++;
      const nextConfig = config;
      if (!nextConfig) {
        log.warn("Reconnect aborted: missing config");
        setState("disconnected");
        return;
      }
      void connect(nextConfig);
    }, delay);
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function handleMessage(raw: string): void {
    const maxSize = config?.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE;

    let parsed: { type?: string; payload?: unknown; id?: string; seq?: number };
    try {
      parsed = JSON.parse(raw) as { type?: string; payload?: unknown; id?: string; seq?: number };
    } catch {
      // Log the size only — `raw` is the decrypted frame (chat plaintext,
      // usernames) and this line is persisted to the on-disk log.
      log.warn("Failed to parse WS message", { bytes: raw.length });
      return;
    }

    // The size guard runs AFTER parsing (raw is already fully materialized
    // in memory either way, so this costs nothing) and exempts the handshake
    // frames: "ready" is the one server frame with no bound — it embeds every
    // member/channel/DM the server knows about — and, unlike a sequenced
    // frame, carries no seq, so nothing ever re-requests it. Dropping it
    // (OC-0160) would leave a client that just flipped to "connected" sitting
    // on empty stores with no error and no recovery path. "auth_ok" gets the
    // same exemption since it can embed a long-username/motd payload and is
    // equally unrecoverable if dropped — the client never even reaches
    // "connected". Every other message type keeps the strict bound.
    if (raw.length > maxSize && parsed.type !== "ready" && parsed.type !== "auth_ok") {
      log.warn("Message exceeds size limit, dropping", { size: raw.length, type: parsed.type });
      return;
    }

    // Track the highest sequence number for reconnection replay.
    const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
    if (seq > lastSeq) {
      lastSeq = seq;
    }

    // Heartbeats have no payload and do not belong in the domain dispatcher.
    if (parsed.type === "pong") {
      for (const listener of pongListeners) listener();
      return;
    }

    if (!parsed.type || parsed.payload === undefined) {
      log.warn("Invalid WS message: missing type or payload", { parsed });
      return;
    }

    const msg = parsed as unknown as ServerMessage;

    log.debug("WS ←", { type: msg.type, id: msg.id });

    // auth_error — non-recoverable
    if (msg.type === "auth_error") {
      log.error("Authentication failed", { message: msg.payload.message });
      intentionalClose = true;
      dispatch(msg);
      void disconnectProxy();
      setState("disconnected");
      return;
    }

    // auth_ok — mark as connected
    if (msg.type === "auth_ok") {
      if (reconnectAttempt > 0) {
        log.info("WebSocket reconnected successfully", {
          afterAttempts: reconnectAttempt,
          host: config?.host ?? "unknown",
          lastSeq,
        });
      }
      // A full re-sync ("none") means the server built this ready state from
      // scratch — its own seq counter may have restarted below our stale
      // watermark (event persistence disabled, pruned events table, restored
      // DB). Keeping the old watermark would make every future reconnect
      // request a range the server can silently satisfy as a complete resume
      // once its counter climbs back through it, dropping the events in
      // between. Reset so the next sequenced frame re-adopts the server's
      // current epoch via the normal seq > lastSeq update (OC-0032).
      if (msg.payload.replay_source === "none") {
        lastSeq = 0;
      }
      setState("connected");
      reconnectAttempt = 0;
      startHeartbeat();
    }

    dispatch(msg);
  }

  function dispatch(msg: ServerMessage): void {
    const typeListeners = listeners.get(msg.type);
    if (!typeListeners || typeListeners.size === 0) {
      log.debug("WS dispatch: no listeners", { type: msg.type });
      return;
    }
    for (const listener of typeListeners) {
      try {
        listener(msg.payload, msg.id);
      } catch (err) {
        log.error(`Listener error for ${msg.type}`, err);
      }
    }
  }

  // The transport's cert-tofu reports, already routed by status: the app's
  // reaction to each is unchanged from when this module listened for the
  // native event itself.
  function handleCertFirstUse(raw: CertTofuEvent): void {
    log.warn("TOFU: first-use certificate — awaiting user confirmation", {
      host: raw.host,
      fingerprint: raw.fingerprint,
    });
    for (const listener of certFirstUseListeners) {
      listener(raw);
    }
  }

  function handleCertMismatch(raw: CertTofuEvent): void {
    const evt: CertTofuEvent = {
      ...raw,
      storedFingerprint: raw.storedFingerprint ?? parseStoredFingerprint(raw.message),
    };
    log.error("Certificate fingerprint mismatch!", {
      host: evt.host,
      fingerprint: evt.fingerprint,
      storedFingerprint: evt.storedFingerprint,
    });
    // Only latch/tear down THIS connection when the mismatch is for the
    // host it's actually connected to — the http proxy emits mismatch
    // events for any tunneled host, and the connect page health-checks
    // every saved profile, so an unrelated profile's rotated cert must not
    // permanently kill this socket's reconnect loop.
    if (config !== null && raw.host === normalizeHostForCertCompare(config.host)) {
      certMismatchBlock = true;
      // A reconnect armed before the mismatch arrived would still fire and
      // call connect(), which clears the latch — resuming the loop against
      // the very host whose certificate just changed. Latching only blocks
      // FUTURE scheduling, so the pending attempt has to be cancelled here.
      cancelReconnect();
      setState("disconnected");
    }
    // Notified unconditionally either way — the connect page's first-use
    // and mismatch modals key off host and need every event.
    for (const listener of certMismatchListeners) {
      listener(evt);
    }
  }

  // The transport's proxy lifecycle, turned into the app's reaction: an open
  // proxy is still unauthenticated until `auth_ok` arrives, and a closed one
  // starts the reconnect policy unless the close was intentional.
  function handleTransportState(next: SocketConnectionState): void {
    if (next === "connected") {
      proxyOpen = true;
      log.info("WebSocket open, sending auth", {
        host: config?.host ?? "unknown",
        isReconnect: reconnectAttempt > 0,
        lastSeq,
      });
      setState("authenticating");
      if (config === null) return;
      // active_channel_id only matters on a resume (last_seq > 0); on a
      // fresh connect the ready payload re-establishes everything anyway.
      // Omitted when unknown so the frame stays byte-identical to before
      // for callers that never register a provider.
      const activeChannelId = lastSeq > 0 ? (activeChannelProvider?.() ?? null) : null;
      send({
        type: "auth",
        payload: {
          token: config.token,
          last_seq: lastSeq,
          epoch: PROTOCOL_EPOCH,
          ...(activeChannelId !== null ? { active_channel_id: activeChannelId } : {}),
        },
      });
    } else if (next === "disconnected") {
      proxyOpen = false;
      log.info("WebSocket closed", {
        host: config?.host ?? "unknown",
        intentional: intentionalClose,
        certBlocked: certMismatchBlock,
      });
      stopHeartbeat();
      if (!intentionalClose) {
        scheduleReconnect();
      } else {
        setState("disconnected");
      }
    }
    // "connecting" — this client sets that state itself before asking the
    // transport to dial, so a report here is already reflected.
  }

  async function connect(cfg: WsClientConfig): Promise<void> {
    wsGeneration++;
    // Captured so a disconnect() landing mid-attempt can be detected on resume
    // — disconnect() bumps wsGeneration too, so a mismatch here means this
    // attempt was cancelled.
    const gen = wsGeneration;
    config = cfg;
    intentionalClose = false;
    // Belt-and-braces: a fresh connect (even one not routed through
    // disconnect(), e.g. a suppressed-modal cert latch from an unrelated
    // host) must not inherit a stale block from a previous connection.
    certMismatchBlock = false;
    cancelReconnect();

    setState("connecting");

    log.info("WebSocket connecting", {
      url: wsUrlFor(cfg.host),
      isReconnect: reconnectAttempt > 0,
      attempt: reconnectAttempt,
    });

    try {
      await transport.connect(cfg);
    } catch (err) {
      if (gen !== wsGeneration) {
        // A disconnect() (or a newer connect()) landed while the transport was
        // dialling — this failure belongs to a superseded attempt.
        return;
      }
      log.error("Tauri APIs not available, cannot connect WebSocket", err);
      proxyOpen = false;
      setState("disconnected");
    }
  }

  function notifySendFailure(id: string | undefined, code: string): void {
    if (id === undefined) return;
    for (const listener of sendFailureListeners) {
      try {
        listener(id, code);
      } catch (err) {
        log.error("Send-failure listener error", err);
      }
    }
  }

  function sendRaw(json: string, id?: string): void {
    if (!proxyOpen) {
      log.warn("Cannot send, WebSocket not open");
      // Deferred so a caller that registers the envelope id right after send()
      // returns (the optimistic-row flow) sees the failure after registration.
      queueMicrotask(() => notifySendFailure(id, "OFFLINE"));
      return;
    }
    void transport.send(json).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("channel full")) {
        // Outbound channel is saturated — surface the drop to listeners so an
        // optimistic row fails with retry instead of silently losing the send.
        // Log id + size only — a slice of `json` can contain the auth
        // envelope's bearer token, and this line is persisted to disk.
        log.warn("ws_send: outbound channel full, message dropped (backpressure)", {
          id,
          bytes: json.length,
        });
        notifySendFailure(id, "NETWORK");
      } else {
        log.error("ws_send failed", err);
        const offline = msg.includes("channel closed") || msg.includes("not connected");
        notifySendFailure(id, offline ? "OFFLINE" : "NETWORK");
      }
    });
  }

  function send(msg: ClientMessage | { type: string; payload: unknown }): string {
    const id = uuid();
    const envelope = { ...msg, id };
    log.debug("WS →", { type: msg.type, id });
    sendRaw(JSON.stringify(envelope), id);
    return id;
  }

  async function disconnectProxy(): Promise<void> {
    await transport.disconnect();
    proxyOpen = false;
  }

  function disconnect(): void {
    // Invalidate any connect() suspended mid-await (e.g. cancelled
    // auto-login, logout racing a fresh connect) so it notices on resume
    // instead of finishing setup and opening the very socket this teardown
    // was meant to prevent. See the transport's own generation guards and
    // connect()'s gen checks.
    wsGeneration++;
    intentionalClose = true;
    log.info("WebSocket disconnecting (intentional)", { host: config?.host ?? "unknown" });
    certMismatchBlock = false;
    cancelReconnect();
    stopHeartbeat();
    proxyOpen = false;
    void disconnectProxy();
    setState("disconnected");
    config = null;
    // Reset lastSeq — disconnect() is only called for intentional close
    // (logout). Automatic reconnects go through scheduleReconnect() which
    // preserves lastSeq for server-side event replay.
    lastSeq = 0;
    // Reset the backoff exponent too — a session abandoned mid-reconnect must
    // not carry its attempt count (and therefore its backoff ceiling) into
    // the next login's first retry.
    reconnectAttempt = 0;
  }

  return {
    connect(cfg: WsClientConfig): void {
      void connect(cfg);
    },

    disconnect,

    /** Send a heartbeat and require a fresh pong on this authenticated socket.
     * Pongs are uncorrelated, so this proves liveness, not an RTT measurement. */
    ping(signal: AbortSignal, timeoutMs = 5000): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (state !== "connected" || !proxyOpen) {
          reject(new Error("The application connection is not ready."));
          return;
        }
        const generation = wsGeneration;
        const cleanup = (): void => {
          clearTimeout(timer);
          pongListeners.delete(onPong);
          stateListeners.delete(onState);
          signal.removeEventListener("abort", onAbort);
        };
        const fail = (reason: unknown): void => {
          cleanup();
          reject(reason);
        };
        const onAbort = (): void => fail(signal.reason);
        const onState = (next: ConnectionState): void => {
          if (next !== "connected") fail(new Error("The application connection changed."));
        };
        const onPong = (): void => {
          if (generation !== wsGeneration) {
            fail(new Error("The application connection changed."));
            return;
          }
          cleanup();
          resolve();
        };
        const timer = setTimeout(
          () => fail(new Error("No heartbeat response arrived.")),
          timeoutMs,
        );
        pongListeners.add(onPong);
        stateListeners.add(onState);
        signal.addEventListener("abort", onAbort, { once: true });
        void transport.send(JSON.stringify({ type: "ping", payload: {} })).catch(fail);
      });
    },

    send(msg: ClientMessage): string {
      return send(msg);
    },

    on<T extends ServerMessage["type"]>(type: T, listener: WsListener<T>): () => void {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      const set = listeners.get(type)!;
      set.add(listener as unknown as WsListener<ServerMessage["type"]>);
      return () => {
        set.delete(listener as unknown as WsListener<ServerMessage["type"]>);
      };
    },

    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    /**
     * Register a listener for local transport send failures (proxy not open,
     * outbound channel full/closed). Called with the envelope id returned by
     * send() and an error code ("OFFLINE" | "NETWORK"). Heartbeat pings and
     * other id-less raw sends never fire it.
     */
    onSendFailure(listener: (id: string, code: string) => void): () => void {
      sendFailureListeners.add(listener);
      return () => sendFailureListeners.delete(listener);
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
      certFirstUseListeners.add(listener);
      return () => certFirstUseListeners.delete(listener);
    },

    /** Register a listener for TOFU certificate mismatch events. */
    onCertMismatch(listener: CertMismatchListener): () => void {
      certMismatchListeners.add(listener);
      return () => certMismatchListeners.delete(listener);
    },

    /**
     * Accept a changed certificate fingerprint for a host.
     * Call after the user acknowledges a cert mismatch warning,
     * then reconnect.
     */
    async acceptCertFingerprint(host: string, fingerprint: string): Promise<void> {
      await transport.acceptCertificate(host, fingerprint);
      certMismatchBlock = false;
    },

    getState(): ConnectionState {
      return state;
    },

    /** @internal for testing */
    _getWs(): WebSocket | null {
      return null;
    },
  };
}

export type WsClient = ReturnType<typeof createWsClient>;
