// The browser platform's socket transport: the page's own `WebSocket`
// behind the `SocketConnection` contract. `lib/ws.ts` keeps everything above
// the seam, as on desktop: the auth frame, the state machine, the reconnect
// policy, frame parsing and the send-failure codes.
//
// One live socket per transport. Each `connect()` is a new attempt with its
// own generation; a superseded attempt's socket is closed, and its events —
// a late close above all — are ignored, so they never reach the live attempt.
// A handshake that has neither opened nor closed after 10 s is given up and
// reported as a lost connection, the same bound the desktop proxy applies.
// The browser keeps certificate trust itself, so there are no certificate
// events and `acceptCertificate` refuses.
import type {
  SocketConnectOptions,
  SocketConnection,
  SocketConnectionState,
  SocketRetryHint,
  SocketTransport,
} from "../contracts/socket";
import { holdSessionToken, releaseSessionToken } from "./session";
import { inertUnsubscribe, refuse, UnavailableError } from "./unavailable";

/** `WebSocket.OPEN`, by spec. */
const OPEN = 1;

/** How long a handshake may take; matches the desktop proxy's connect bound
 *  (`src-tauri/src/ws_proxy.rs`, `CONNECT_TIMEOUT`). */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** A plain-http page reaches this only on a loopback host (any other http
 *  page is not a secure context, and the router shows only a notice there).
 *  `lib/ws.ts` builds `wss:` URLs, so for the page's own host only, dial
 *  `ws:`: a page on `http:` may not do better, and another host is never
 *  downgraded. */
function dialUrl(url: string): string {
  const page = globalThis.location;
  if (page === undefined || page.protocol !== "http:") return url;
  try {
    const target = new URL(url);
    if (target.protocol === "wss:" && target.host === page.host) {
      target.protocol = "ws:";
      return target.href;
    }
  } catch {
    // Not a URL; the constructor reports it.
  }
  return url;
}

function createBrowserSocket(): SocketConnection {
  const messageListeners = new Set<(text: string) => void>();
  const stateListeners = new Set<
    (state: SocketConnectionState, retryHint?: SocketRetryHint) => void
  >();

  /** Incremented by every connect() and disconnect(); an attempt acts only
   *  while it still holds the current value. */
  let generation = 0;
  let live: WebSocket | null = null;
  /** Settles the current attempt's connect() promise. */
  let settleAttempt: (() => void) | null = null;
  /** The current attempt's handshake timer, until it opens or closes. */
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Identifies this connection to the tab's session holder. */
  const sessionOwner = {};

  function clearHandshakeTimer(): void {
    if (handshakeTimer !== null) clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  function report(state: SocketConnectionState): void {
    for (const listener of stateListeners) listener(state);
  }

  /** End the current attempt: settle its promise and close its socket. Its
   *  late events then fail the generation check. */
  function retire(): void {
    clearHandshakeTimer();
    settleAttempt?.();
    settleAttempt = null;
    const socket = live;
    live = null;
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      // Already closing; nothing more to release.
    }
  }

  async function connect(options: SocketConnectOptions): Promise<void> {
    generation++;
    const gen = generation;
    retire();
    holdSessionToken(sessionOwner, options.token);
    const Socket: typeof WebSocket | undefined = globalThis.WebSocket;
    if (typeof Socket !== "function") throw new UnavailableError();

    report("connecting");
    // A listener may have started a newer attempt in reaction.
    if (gen !== generation) return;
    let socket: WebSocket;
    try {
      socket = new Socket(dialUrl(options.url));
    } catch {
      // A URL the page may not dial: the same outcome as a failed handshake.
      report("disconnected");
      return;
    }
    live = socket;

    // Settles once the handshake does (open or close), or when a newer
    // attempt or a disconnect retires this one.
    await new Promise<void>((resolve) => {
      settleAttempt = resolve;
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (gen !== generation || live !== socket) return;
        // Retiring first means the close that follows finds the attempt
        // gone, so the loss is reported exactly once.
        retire();
        report("disconnected");
      }, HANDSHAKE_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (gen !== generation || live !== socket) return;
        clearHandshakeTimer();
        report("connected");
        resolve();
      });
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (gen !== generation) return;
        // The server speaks text frames only.
        if (typeof event.data !== "string") return;
        for (const listener of messageListeners) listener(event.data);
      });
      socket.addEventListener("close", () => {
        resolve();
        if (gen !== generation || live !== socket) return;
        clearHandshakeTimer();
        live = null;
        settleAttempt = null;
        report("disconnected");
      });
    });
  }

  async function disconnect(): Promise<void> {
    generation++;
    retire();
    releaseSessionToken(sessionOwner);
  }

  async function send(text: string): Promise<void> {
    const socket = live;
    if (socket === null || socket.readyState !== OPEN) {
      // i18n-exempt: diagnostic
      throw new Error("not connected");
    }
    socket.send(text);
  }

  return {
    connect,
    disconnect,
    send,
    acceptCertificate: () => refuse(),
    onStateChange(handler) {
      stateListeners.add(handler);
      return () => stateListeners.delete(handler);
    },
    onMessage(handler) {
      messageListeners.add(handler);
      return () => messageListeners.delete(handler);
    },
    onCertFirstUse: inertUnsubscribe,
    onCertMismatch: inertUnsubscribe,
    startCertListener: async () => undefined,
  };
}

/** The socket capability: one transport per call. */
export const socket: SocketTransport = { create: createBrowserSocket };
