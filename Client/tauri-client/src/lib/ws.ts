// Step 2.15 — WebSocket Client
// Uses Tauri IPC (ws_connect/ws_send/ws_disconnect commands + events)
// to proxy WSS through Rust, bypassing self-signed cert issues in webview.

import type { ServerMessage, ClientMessage } from "./types";
import { createLogger } from "./logger";

const log = createLogger("ws");

// Tauri IPC imports — resolved at runtime in Tauri context
let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let tauriListen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;

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
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

export type WsListener<T extends ServerMessage["type"]> = (
  payload: Extract<ServerMessage, { type: T }>["payload"],
  id?: string,
) => void;

/** TOFU certificate event emitted by the Rust WS proxy. */
export interface CertTofuEvent {
  readonly host: string;
  readonly fingerprint: string;
  readonly status: "trusted_first_use" | "trusted" | "mismatch";
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

export interface WsClientConfig {
  readonly host: string;
  readonly token: string;
  readonly maxReconnectDelayMs?: number;
  readonly maxMessageSizeBytes?: number;
}

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_MAX_MESSAGE_SIZE = 1_048_576; // 1MB
const HEARTBEAT_INTERVAL_MS = 30_000;

function uuid(): string {
  return crypto.randomUUID();
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

  // Deduplication cache for reconnection replay.
  // Active when reconnecting (reconnectAttempt > 0) until auth_ok.
  let replayDedup: Set<string> | null = null;
  const MAX_DEDUP_SIZE = 1000;

  // Tauri event unsubscribe functions
  const eventUnsubs: Array<() => void> = [];

  // Type-safe listener registry
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();

  // State change listeners
  const stateListeners = new Set<(state: ConnectionState) => void>();

  // TOFU cert mismatch listeners
  const certMismatchListeners = new Set<CertMismatchListener>();

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
      connect(config!);
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

    if (raw.length > maxSize) {
      log.warn("Message exceeds size limit, dropping", { size: raw.length });
      return;
    }

    let parsed: { type?: string; payload?: unknown; id?: string; seq?: number };
    try {
      parsed = JSON.parse(raw) as { type?: string; payload?: unknown; id?: string; seq?: number };
    } catch {
      log.warn("Failed to parse WS message", { data: raw });
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

    // Deduplication during reconnection replay
    if (replayDedup !== null && msg.type !== "auth_ok" && msg.type !== "auth_error" && msg.type !== "ready") {
      const dedupKey = msg.id ?? `${msg.type}:${seq}`;
      if (replayDedup.has(dedupKey)) {
        log.debug("Dedup: skipping duplicate message", { type: msg.type, key: dedupKey });
        return;
      }
      replayDedup.add(dedupKey);
      // Evict oldest entries if set is too large
      if (replayDedup.size > MAX_DEDUP_SIZE) {
        const first = replayDedup.values().next().value;
        if (first !== undefined) replayDedup.delete(first);
      }
    }

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
      // Clear dedup cache — replay is complete
      replayDedup = null;
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
        (listener as WsListener<typeof msg.type>)(
          msg.payload as Extract<ServerMessage, { type: typeof msg.type }>["payload"],
          msg.id,
        );
      } catch (err) {
        log.error(`Listener error for ${msg.type}`, err);
      }
    }
  }

  async function setupEventListeners(): Promise<void> {
    if (tauriListen === null) return;

    // Server messages
    const unsubMsg = await tauriListen("ws-message", (e) => {
      handleMessage(e.payload as string);
    });
    eventUnsubs.push(unsubMsg);

    // Connection state changes from Rust
    const unsubState = await tauriListen("ws-state", (e) => {
      const rustState = e.payload as string;
      log.debug("Rust WS state", { state: rustState });

      if (rustState === "open") {
        proxyOpen = true;
        log.info("WebSocket open, sending auth", {
          host: config?.host ?? "unknown",
          isReconnect: reconnectAttempt > 0,
          lastSeq,
        });
        // Enable dedup during reconnection replay
        if (reconnectAttempt > 0 && lastSeq > 0) {
          replayDedup = new Set();
        }
        setState("authenticating");
        send({ type: "auth", payload: { token: config!.token, last_seq: lastSeq } });
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
    eventUnsubs.push(unsubState);

    // Errors
    const unsubErr = await tauriListen("ws-error", (e) => {
      log.warn("WebSocket error (proxy)", { error: e.payload });
    });
    eventUnsubs.push(unsubErr);

    // TOFU certificate events
    const unsubCert = await tauriListen("cert-tofu", (e) => {
      const raw = e.payload as CertTofuEvent;
      log.info("TOFU cert event", { host: raw.host, status: raw.status });

      if (raw.status === "mismatch") {
        const evt: CertTofuEvent = {
          ...raw,
          storedFingerprint: parseStoredFingerprint(raw.message),
        };
        log.error("Certificate fingerprint mismatch!", {
          host: evt.host,
          fingerprint: evt.fingerprint,
          storedFingerprint: evt.storedFingerprint,
        });
        certMismatchBlock = true;
        setState("disconnected");
        for (const listener of certMismatchListeners) {
          listener(evt);
        }
      }
    });
    eventUnsubs.push(unsubCert);
  }

  function cleanupEventListeners(): void {
    for (const unsub of eventUnsubs) {
      try {
        // Unsub may return a rejected promise if the Tauri resource
        // was already invalidated after disconnect — safe to ignore.
        const result = unsub() as unknown;
        if (result instanceof Promise) {
          result.catch(() => {});
        }
      } catch {
        // Sync errors also safe to ignore.
      }
    }
    eventUnsubs.length = 0;
  }

  async function connect(cfg: WsClientConfig): Promise<void> {
    config = cfg;
    intentionalClose = false;
    cancelReconnect();

    setState("connecting");

    await ensureTauriApis();
    if (tauriInvoke === null) {
      log.error("Tauri APIs not available, cannot connect WebSocket");
      setState("disconnected");
      return;
    }

    const wsUrl = `wss://${cfg.host}/api/v1/ws`;
    log.info("WebSocket connecting", {
      url: wsUrl,
      isReconnect: reconnectAttempt > 0,
      attempt: reconnectAttempt,
    });

    // Set up event listeners before connecting
    cleanupEventListeners();
    await setupEventListeners();

    try {
      await tauriInvoke("ws_connect", { url: wsUrl });
    } catch (err) {
      log.error("ws_connect failed", err);
      proxyOpen = false;

      // Cert mismatch is handled by the cert-tofu event listener
      // (which sets certMismatchBlock before this catch runs).
      // scheduleReconnect() checks certMismatchBlock and will no-op if set.
      scheduleReconnect();
    }
  }

  function sendRaw(json: string): void {
    if (tauriInvoke === null || !proxyOpen) {
      log.warn("Cannot send, WebSocket not open");
      return;
    }
    tauriInvoke("ws_send", { message: json }).catch((err) => {
      log.error("ws_send failed", err);
    });
  }

  function send(msg: ClientMessage | { type: string; payload: unknown }): string {
    const id = uuid();
    const envelope = { ...msg, id };
    log.debug("WS →", { type: msg.type, id });
    sendRaw(JSON.stringify(envelope));
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
    intentionalClose = true;
    log.info("WebSocket disconnecting (intentional)", { host: config?.host ?? "unknown" });
    certMismatchBlock = false;
    cancelReconnect();
    stopHeartbeat();
    cleanupEventListeners();
    void disconnectProxy();
    setState("disconnected");
    // Reset lastSeq — disconnect() is only called for intentional close
    // (logout). Automatic reconnects go through scheduleReconnect() which
    // preserves lastSeq for server-side event replay.
    lastSeq = 0;
  }

  return {
    connect(cfg: WsClientConfig): void {
      void connect(cfg);
    },

    disconnect,

    send(msg: ClientMessage): string {
      return send(msg);
    },

    on<T extends ServerMessage["type"]>(
      type: T,
      listener: WsListener<T>,
    ): () => void {
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

    /** True while processing reconnection replay messages (dedup active). */
    isReplaying(): boolean {
      return replayDedup !== null;
    },

    /** @internal for testing */
    _getWs(): WebSocket | null {
      return null;
    },
  };
}

export type WsClient = ReturnType<typeof createWsClient>;
