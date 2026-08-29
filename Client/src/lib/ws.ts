// Step 2.15 — WebSocket Client
// Uses Tauri IPC (ws_connect/ws_send/ws_disconnect commands + events)
// to proxy WSS through Rust, bypassing self-signed cert issues in webview.

import type { ServerMessage, ClientMessage } from "./types";
import { createLogger } from "./logger";
import { PROTOCOL_EPOCH } from "./protocolTypes";

const log = createLogger("ws");

/** Monotonic generation counter — incremented on each connect() to invalidate
 *  stale event listeners from a previous connection attempt. */
let wsGeneration = 0;

// Tauri IPC imports — resolved at runtime in Tauri context
let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let tauriListen:
  ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null =
  null;

// Dynamically load Tauri APIs (avoids import errors in test/browser env)
async function ensureTauriApis(): Promise<void> {
  if (tauriInvoke !== null) return;
  try {
    const core = await import("@tauri-apps/api/core");
    const event = await import("@tauri-apps/api/event");
    tauriInvoke = core.invoke;
    tauriListen = event.listen;
  } catch {
    log.warn("Tauri APIs not available — WebSocket proxy will not work");
  }
}

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
 *  port keeps its brackets as its own distinct key (OC-0163). */
export function normalizeHostForCertCompare(host: string): string {
  return host
    .replace(/:443$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
}

/**
 * Wrap a bare (unbracketed) IPv6 literal in brackets so it can be embedded in
 * a `wss://` authority, mirroring the detection api.ts's `isValidHost` and
 * livekitSession.ts's `ensureLiveKitProxy` already use: more than one colon
 * means the whole string is the address (a single colon is the host:port
 * separator instead), and RFC 3986 gives a bare IPv6 literal no way to carry
 * a port, so this never needs to split one off. A host that is already
 * bracketed (or is a DNS name / IPv4 literal, with or without a port) is
 * returned unchanged (OC-0163).
 */
export function bracketBareIPv6Host(host: string): string {
  if (
    !host.startsWith("[") &&
    (host.match(/:/g) ?? []).length > 1 &&
    /^[0-9A-Fa-f:.]+$/.test(host)
  ) {
    return `[${host}]`;
  }
  return host;
}

export function createWsClient() {
  let config: WsClientConfig | null = null;
  let state: ConnectionState = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let intentionalClose = false;
  let certMismatchBlock = false; // blocks reconnect on TOFU mismatch
  let proxyOpen = false;
  let lastSeq = 0;

  // Tauri event unsubscribe functions
  const eventUnsubs: Array<() => void> = [];

  // Type-safe listener registry
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();

  // State change listeners
  const stateListeners = new Set<(state: ConnectionState) => void>();

  // Local send-failure listeners (transport level: proxy not open, outbound
  // channel full/closed). Notified with the envelope id so the dispatcher can
  // fail the matching optimistic row instead of dropping the send silently.
  const sendFailureListeners = new Set<(id: string, code: string) => void>();

  // TOFU cert mismatch listeners
  const certMismatchListeners = new Set<CertMismatchListener>();

  // TOFU first-use confirmation listeners (F4/F8)
  const certFirstUseListeners = new Set<CertFirstUseListener>();

  // Global cert-tofu Tauri listener unsub (registered once via startCertListener,
  // active for the whole app lifetime so first-use/mismatch events are received
  // during the connect page's health checks — before any WS connect).
  let certListenerUnsub: (() => void) | null = null;

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
        } catch {
          // Connection may have dropped
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

    // Server pong messages have no payload — silently ignore.
    if (parsed.type === "pong") return;

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

  // Route a cert-tofu event (from the http or ws proxy) to the right listeners.
  // Registered globally via startCertListener so first-use/mismatch events are
  // received during the connect page's health checks, before any WS connect.
  function handleCertTofu(raw: CertTofuEvent): void {
    log.info("TOFU cert event", { host: raw.host, status: raw.status });
    if (raw.status === "first_use") {
      log.warn("TOFU: first-use certificate — awaiting user confirmation", {
        host: raw.host,
        fingerprint: raw.fingerprint,
      });
      for (const listener of certFirstUseListeners) {
        listener(raw);
      }
    } else if (raw.status === "mismatch") {
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
    // "trusted" → no action
  }

  // Registers this attempt's Tauri event listeners and returns the unsub
  // handles it created, WITHOUT touching the shared `eventUnsubs` array.
  // Ownership of those handles (splicing them into `eventUnsubs`, or tearing
  // them down if this attempt turns out to be stale) is the caller's job —
  // see connect(). This keeps a still-in-flight attempt's registrations from
  // ever being visible to (and therefore clearable by) another attempt that
  // resumes around the same time; see OC-0219.
  async function setupEventListeners(): Promise<Array<() => void>> {
    if (tauriListen === null) return [];

    // Capture generation so stale listeners from a previous connect() are no-ops.
    const gen = wsGeneration;
    const ownUnsubs: Array<() => void> = [];

    // Server messages
    const unsubMsg = await tauriListen("ws-message", (e) => {
      if (gen !== wsGeneration) return;
      handleMessage(e.payload as string);
    });
    ownUnsubs.push(unsubMsg);

    // Connection state changes from Rust
    const unsubState = await tauriListen("ws-state", (e) => {
      if (gen !== wsGeneration) return;
      const rustState = e.payload as string;
      log.debug("Rust WS state", { state: rustState });

      if (rustState === "open") {
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
      } else if (rustState === "closed") {
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
    });
    ownUnsubs.push(unsubState);

    // Errors
    const unsubErr = await tauriListen("ws-error", (e) => {
      if (gen !== wsGeneration) return;
      log.warn("WebSocket error (proxy)", { error: e.payload });
    });
    ownUnsubs.push(unsubErr);

    // Register the global cert-tofu listener on first connect (idempotent).
    // startCertListener() registers the same listener at app bootstrap so
    // first-use/mismatch events are also caught during the connect page's health
    // checks, before any WS connection exists. Deliberately NOT part of
    // ownUnsubs/eventUnsubs — it is a singleton for the app's lifetime, not
    // scoped to any one connect() attempt.
    if (certListenerUnsub === null) {
      certListenerUnsub = await tauriListen("cert-tofu", (e) => {
        handleCertTofu(e.payload as CertTofuEvent);
      });
    }

    return ownUnsubs;
  }

  // Invokes each unsub handle in `unsubs`, tolerating handles that throw or
  // return a rejected promise (the Tauri resource may already have been
  // invalidated after disconnect).
  function unsubscribeAll(unsubs: ReadonlyArray<() => void>): void {
    for (const unsub of unsubs) {
      try {
        const result = unsub() as unknown;
        if (result instanceof Promise) {
          result.catch((err) => {
            log.warn("Failed to unsubscribe Tauri event listener", err);
          });
        }
      } catch {
        // Sync errors also safe to ignore.
      }
    }
  }

  function cleanupEventListeners(): void {
    unsubscribeAll(eventUnsubs);
    eventUnsubs.length = 0;
  }

  async function connect(cfg: WsClientConfig): Promise<void> {
    wsGeneration++;
    // Captured so a disconnect() landing mid-await (this function has three
    // await points below) can be detected on resume — disconnect() bumps
    // wsGeneration too, so a mismatch here means this attempt was cancelled.
    const gen = wsGeneration;
    config = cfg;
    intentionalClose = false;
    // Belt-and-braces: a fresh connect (even one not routed through
    // disconnect(), e.g. a suppressed-modal cert latch from an unrelated
    // host) must not inherit a stale block from a previous connection.
    certMismatchBlock = false;
    cancelReconnect();

    setState("connecting");

    await ensureTauriApis();
    if (gen !== wsGeneration) {
      // A disconnect() (or a newer connect()) landed while we were
      // suspended here — this attempt is cancelled, do not proceed.
      return;
    }
    if (tauriInvoke === null) {
      log.error("Tauri APIs not available, cannot connect WebSocket");
      setState("disconnected");
      return;
    }

    const wsUrl = `wss://${bracketBareIPv6Host(cfg.host)}/api/v1/ws`;
    log.info("WebSocket connecting", {
      url: wsUrl,
      isReconnect: reconnectAttempt > 0,
      attempt: reconnectAttempt,
    });

    // Set up event listeners before connecting. setupEventListeners() hands
    // back only the handles THIS attempt registered — they are not spliced
    // into the shared `eventUnsubs` until the gen check below confirms this
    // attempt is still current. That ownership split is what stops a stale
    // attempt's cleanup (just below) from ever reaching a newer attempt's
    // listeners, even if the newer attempt finished registering its own
    // listeners while this one was still suspended above (OC-0219).
    cleanupEventListeners();
    const ownUnsubs = await setupEventListeners();
    if (gen !== wsGeneration) {
      // Cancelled while awaiting the Tauri IPC round trips inside
      // setupEventListeners(). Tear down only the listeners THIS (now-stale)
      // attempt just registered — never the shared eventUnsubs array, which
      // may already hold a newer attempt's live listeners by now.
      unsubscribeAll(ownUnsubs);
      return;
    }
    eventUnsubs.push(...ownUnsubs);

    try {
      await tauriInvoke("ws_connect", { url: wsUrl });
    } catch (err) {
      if (gen !== wsGeneration) {
        // A disconnect() (or a newer connect()) landed while we were
        // suspended on the Tauri IPC round trip — this rejection belongs to
        // a superseded attempt (the Rust proxy deliberately rejects a
        // handshake it displaced with "superseded by a newer connection").
        // The newer attempt may already be connected; do not act on it.
        log.debug("ws_connect rejection from superseded attempt, ignoring", err);
        return;
      }
      log.error("ws_connect failed", err);
      proxyOpen = false;

      // Cert mismatch is handled by the cert-tofu event listener
      // (which sets certMismatchBlock before this catch runs).
      // scheduleReconnect() checks certMismatchBlock and will no-op if set.
      scheduleReconnect();
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
    if (tauriInvoke === null || !proxyOpen) {
      log.warn("Cannot send, WebSocket not open");
      // Deferred so a caller that registers the envelope id right after send()
      // returns (the optimistic-row flow) sees the failure after registration.
      queueMicrotask(() => notifySendFailure(id, "OFFLINE"));
      return;
    }
    tauriInvoke("ws_send", { message: json }).catch((err: unknown) => {
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
    if (tauriInvoke !== null) {
      try {
        await tauriInvoke("ws_disconnect");
      } catch {
        // ignore
      }
    }
    proxyOpen = false;
  }

  function disconnect(): void {
    // Invalidate any connect() suspended mid-await (e.g. cancelled
    // auto-login, logout racing a fresh connect) so it notices on resume
    // instead of finishing setup and opening the very socket this teardown
    // was meant to prevent. See setupEventListeners()'s tauriListen guards
    // and connect()'s own gen checks.
    wsGeneration++;
    intentionalClose = true;
    log.info("WebSocket disconnecting (intentional)", { host: config?.host ?? "unknown" });
    certMismatchBlock = false;
    cancelReconnect();
    stopHeartbeat();
    cleanupEventListeners();
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
      if (certListenerUnsub !== null) return;
      await ensureTauriApis();
      if (tauriListen === null) return;
      certListenerUnsub = await tauriListen("cert-tofu", (e) => {
        handleCertTofu(e.payload as CertTofuEvent);
      });
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
      await ensureTauriApis();
      if (tauriInvoke === null) {
        throw new Error("Tauri APIs not available");
      }
      await tauriInvoke("accept_cert_fingerprint", { host, fingerprint });
      certMismatchBlock = false;
      log.info("Accepted new cert fingerprint", { host });
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
