// The native socket transport: the host's socket proxy behind the
// `SocketConnection` contract. Lifted verbatim from `lib/ws.ts` (B7-4) — the
// four proxy commands and the four event registrations, unchanged — so the
// app-side socket layer in `lib/ws.ts` keeps its state machine, its reconnect
// policy, its frame parsing and its send-failure codes above this seam.
//
// The registered capability (`socket`) is the factory: one transport per
// call, because a fresh login — and every test — must not inherit the
// previous connection's listeners or its certificate registration.
import { createLogger } from "@lib/logger";
import type {
  SocketCertEvent,
  SocketConnectOptions,
  SocketConnection,
  SocketConnectionState,
  SocketTransport,
} from "../contracts/socket";

const log = createLogger("ws");

/**
 * The native socket connection: the four proxy commands (`ws_connect`,
 * `ws_send`, `ws_disconnect`, `accept_cert_fingerprint`) and the four event
 * registrations (`ws-message`, `ws-state`, `ws-error`, `cert-tofu`) that reach
 * the Rust proxy.
 *
 * Lifted verbatim from `lib/ws.ts`, which is where the app-side layers on top
 * of it stay: the state machine, the reconnect policy, frame parsing and the
 * send-failure codes. In particular `onMessage` hands out the raw frame text
 * and `onStateChange` reports the proxy's own lifecycle; neither parses a
 * protocol frame.
 *
 * The concrete type is wider than `SocketTransport` in exactly one way: the
 * three commands this module awaits resolve as promises (`connect` also
 * rejects when there is no native host at all, which is today's early return
 * in `connect()`), and `startCertListener()` is the bootstrap registration
 * `main.ts` makes before any connection exists. All three are assignable to
 * the contract's `void` members.
 */
function createSocketConnection(): SocketConnection {
  // Native IPC handles — resolved at runtime in the native context.
  let tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null =
    null;
  let tauriListen:
    ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null =
    null;

  const messageListeners = new Set<(text: string) => void>();
  const stateListeners = new Set<(state: SocketConnectionState) => void>();
  const certFirstUseListeners = new Set<(event: SocketCertEvent) => void>();
  const certMismatchListeners = new Set<(event: SocketCertEvent) => void>();

  /** Monotonic generation counter — incremented on each connect() so a stale
   *  attempt's listeners and IPC rejections are ignored. */
  let generation = 0;

  // Native event unsubscribe functions
  const eventUnsubs: Array<() => void> = [];

  // Global cert-tofu listener unsub (registered once, active for the whole app
  // lifetime so first-use/mismatch events are received during the connect
  // page's health checks — before any WS connect).
  let certListenerUnsub: (() => void) | null = null;

  // Dynamically load the native APIs (avoids import errors in test/browser env)
  async function ensureApis(): Promise<void> {
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

  // Invokes each unsub handle in `unsubs`, tolerating handles that throw or
  // return a rejected promise (the native resource may already have been
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
      } catch (err) {
        log.debug("Sync unsubscribe error (safe to ignore)", err);
      }
    }
  }

  function cleanupEventListeners(): void {
    unsubscribeAll(eventUnsubs);
    eventUnsubs.length = 0;
  }

  // Route a cert-tofu event (from the http or ws proxy) to the right listeners.
  // Registered globally via startCertListener so first-use/mismatch events are
  // received during the connect page's health checks, before any WS connect.
  function handleCertTofu(raw: SocketCertEvent): void {
    log.info("TOFU cert event", { host: raw.host, status: raw.status });
    if (raw.status === "first_use") {
      for (const listener of certFirstUseListeners) listener(raw);
    } else if (raw.status === "mismatch") {
      for (const listener of certMismatchListeners) listener(raw);
    }
    // "trusted" → no action
  }

  // Registers this attempt's native event listeners and returns the unsub
  // handles it created, WITHOUT touching the shared `eventUnsubs` array.
  // Ownership of those handles (splicing them in, or tearing them down if this
  // attempt turns out to be stale) is the caller's job — see connect(). This
  // keeps a still-in-flight attempt's registrations from ever being visible to
  // (and therefore clearable by) another attempt that resumes around the same
  // time; see OC-0219.
  async function setupEventListeners(): Promise<Array<() => void>> {
    if (tauriListen === null) return [];

    // Capture generation so stale listeners from a previous connect() are no-ops.
    const gen = generation;
    const ownUnsubs: Array<() => void> = [];

    // Server messages — raw frame text, exactly as the native transport
    // delivered it.
    const unsubMsg = await tauriListen("ws-message", (e) => {
      if (gen !== generation) return;
      for (const listener of messageListeners) listener(e.payload as string);
    });
    ownUnsubs.push(unsubMsg);

    // Connection state changes from the proxy
    const unsubState = await tauriListen("ws-state", (e) => {
      if (gen !== generation) return;
      const rustState = e.payload as string;
      log.debug("Rust WS state", { state: rustState });

      if (rustState === "open") {
        for (const listener of stateListeners) listener("connected");
      } else if (rustState === "closed") {
        for (const listener of stateListeners) listener("disconnected");
      }
    });
    ownUnsubs.push(unsubState);

    // Errors
    const unsubErr = await tauriListen("ws-error", (e) => {
      if (gen !== generation) return;
      log.warn("WebSocket error (proxy)", { error: e.payload });
    });
    ownUnsubs.push(unsubErr);

    // Register the global cert-tofu listener on first connect (idempotent).
    // Deliberately NOT part of ownUnsubs/eventUnsubs — it is a singleton for
    // the app's lifetime, not scoped to any one connect() attempt.
    if (certListenerUnsub === null) {
      certListenerUnsub = await tauriListen("cert-tofu", (e) => {
        handleCertTofu(e.payload as SocketCertEvent);
      });
    }

    return ownUnsubs;
  }

  async function connect(options: SocketConnectOptions): Promise<void> {
    generation++;
    // Captured so a disconnect() landing mid-await (this function has three
    // await points below) can be detected on resume — disconnect() bumps
    // generation too, so a mismatch here means this attempt was cancelled.
    const gen = generation;
    await ensureApis();
    if (gen !== generation) {
      // A disconnect() (or a newer connect()) landed while we were suspended
      // here — this attempt is cancelled, do not proceed.
      return;
    }
    if (tauriInvoke === null) {
      // i18n-exempt: internal desktop seam guard, never rendered
      throw new Error("Tauri APIs not available");
    }

    for (const listener of stateListeners) listener("connecting");

    // Set up event listeners before connecting. setupEventListeners() hands
    // back only the handles THIS attempt registered — they are not spliced
    // into the shared `eventUnsubs` until the gen check below confirms this
    // attempt is still current. That ownership split is what stops a stale
    // attempt's cleanup from ever reaching a newer attempt's listeners, even
    // if the newer attempt finished registering its own listeners while this
    // one was still suspended above (OC-0219).
    cleanupEventListeners();
    const ownUnsubs = await setupEventListeners();
    if (gen !== generation) {
      // Cancelled while awaiting the native IPC round trips inside
      // setupEventListeners(). Tear down only the listeners THIS (now-stale)
      // attempt just registered — never the shared eventUnsubs array, which
      // may already hold a newer attempt's live listeners by now.
      unsubscribeAll(ownUnsubs);
      return;
    }
    eventUnsubs.push(...ownUnsubs);

    try {
      await tauriInvoke("ws_connect", { url: options.url });
    } catch (err) {
      if (gen !== generation) {
        // A disconnect() (or a newer connect()) landed while we were suspended
        // on the native IPC round trip — this rejection belongs to a
        // superseded attempt (the proxy deliberately rejects a handshake it
        // displaced with "superseded by a newer connection"). The newer
        // attempt may already be connected; do not act on it.
        log.debug("ws_connect rejection from superseded attempt, ignoring", err);
        return;
      }
      log.error("ws_connect failed", err);
      // Cert mismatch is handled by the cert-tofu event listener, which
      // latches before this catch runs; the reconnect policy above the seam
      // checks that latch and will no-op if it is set.
      for (const listener of stateListeners) listener("disconnected");
    }
  }

  async function disconnect(): Promise<void> {
    // Invalidate any connect() suspended mid-await so it notices on resume
    // instead of finishing setup and opening the very socket this teardown
    // was meant to prevent.
    generation++;
    cleanupEventListeners();
    if (tauriInvoke !== null) {
      try {
        await tauriInvoke("ws_disconnect");
      } catch (err) {
        log.debug("ws_disconnect error during cleanup (safe to ignore)", err);
      }
    }
  }

  async function acceptCertificate(host: string, fingerprint: string): Promise<void> {
    await ensureApis();
    if (tauriInvoke === null) {
      // i18n-exempt: internal desktop seam guard, never rendered
      throw new Error("Tauri APIs not available");
    }
    await tauriInvoke("accept_cert_fingerprint", { host, fingerprint });
    log.info("Accepted new cert fingerprint", { host });
  }

  return {
    connect,
    disconnect,
    async send(text: string): Promise<void> {
      if (tauriInvoke === null) {
        // i18n-exempt: internal desktop seam guard, never rendered
        throw new Error("Tauri APIs not available");
      }
      await tauriInvoke("ws_send", { message: text });
    },
    acceptCertificate,

    onMessage(handler: (text: string) => void): () => void {
      messageListeners.add(handler);
      return () => messageListeners.delete(handler);
    },

    onStateChange(handler: (state: SocketConnectionState) => void): () => void {
      stateListeners.add(handler);
      return () => stateListeners.delete(handler);
    },

    onCertFirstUse(handler: (event: SocketCertEvent) => void): () => void {
      certFirstUseListeners.add(handler);
      return () => certFirstUseListeners.delete(handler);
    },

    onCertMismatch(handler: (event: SocketCertEvent) => void): () => void {
      certMismatchListeners.add(handler);
      return () => certMismatchListeners.delete(handler);
    },

    async startCertListener(): Promise<void> {
      if (certListenerUnsub !== null) return;
      await ensureApis();
      if (tauriListen === null) return;
      certListenerUnsub = await tauriListen("cert-tofu", (e) => {
        handleCertTofu(e.payload as SocketCertEvent);
      });
    },
  };
}

/** The socket capability: one transport per call. */
export const socket: SocketTransport = { create: createSocketConnection };
