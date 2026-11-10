// The per-client mutable state of createWsClient, gathered into one object so
// the modules beside this file take it as an explicit argument instead of
// closing over it. Nothing here is module-level: each client builds its own.

import type { SocketConnection } from "../../../platform/contracts/socket";
import type { Disposable } from "../../disposable";
import { createLogger } from "../../logger";
import type {
  CertFirstUseListener,
  CertMismatchListener,
  ConnectionState,
  WsClientConfig,
} from "../../wsConfig";
import { currentGeneration } from "./generation";

const log = createLogger("ws");

/** Dependencies for the backoff policy only; session/heartbeat clocks are unchanged. */
export interface ReconnectDependencies {
  /** Uniform sample in [0, 1]. */
  readonly random?: () => number;
  readonly clock?: {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}

export interface WsState {
  // One transport per client: the certificate listener it registers is
  // app-lifetime state, and a second client (a fresh login, a test) must not
  // inherit a registration the first one made.
  readonly transport: SocketConnection;
  readonly random: () => number;
  readonly clock: NonNullable<ReconnectDependencies["clock"]>;
  /** Starts a dial; the reconnect loop's redial goes through it. */
  readonly dial: (cfg: WsClientConfig) => Promise<void>;

  config: WsClientConfig | null;
  state: ConnectionState;
  // When the current attempt's connect() started, for ws.ready's after_ms.
  attemptStartedAt: number;
  // The generation whose socket opened last, so its close is tagged with it
  // even after a disconnect() or a newer connect() moved the counter on.
  socketGeneration: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  // Fires when no inbound frame has arrived for SERVER_SILENCE_RECONNECT_MS
  // while the socket still reports open.
  livenessTimer: ReturnType<typeof setTimeout> | null;
  livenessDueAt: number;
  // Owns the visibilitychange / online wake-probe listeners. Armed on auth_ok;
  // kept through the reconnect loop and released on an intentional or
  // certificate-blocked close, or disconnect().
  wakeOwner: Disposable | null;
  // When app.resumed was last recorded, so one suspend is recorded once.
  lastResumeRecordedAt: number | null;
  // When a wake signal last cut a reconnect backoff short.
  lastWakeKickAt: number;
  // The last time the app could observe the clock running: a parsed inbound
  // frame, a heartbeat tick, a dial or a reconnect-point check. A jump larger
  // than WAKE_GAP_MS between reads means the process was suspended, so the
  // next dial is marked a wake (pendingWake).
  lastActivityAt: number;
  // When the oldest heartbeat ping sent since the last inbound frame went out.
  unansweredPingAt: number | null;
  intentionalClose: boolean;
  // Set when a real suspend is seen; while set, every auth frame carries
  // `wake: true`. Cleared only by auth_ok, an explicit takeover or disconnect().
  pendingWake: boolean;
  certMismatchBlock: boolean; // blocks reconnect on TOFU mismatch
  // The distinct failure code from the most recent rejected connect, when the
  // transport could read one. Cleared on each new dial and on a successful connect.
  connectFailureCode: string | null;
  // Mirror of the proxy's own open/closed state, kept here because the
  // send-failure codes are decided on this side of the seam.
  proxyOpen: boolean;
  lastSeq: number;
  // The last `cseq` seen on the current socket (0 before the first), the socket
  // it belongs to, and the pending gap resume, if any.
  lastCseq: number;
  socketId: number;
  gapResumeTimer: ReturnType<typeof setTimeout> | null;
  // Back-to-back gap resumes, kept across sockets (auth_ok does not reset it).
  gapStreak: number;
  lastGapResumeAt: number;
  // An announced restart's redial point and this client's random offset.
  restartRedialAt: number | null;
  restartOffsetMs: number;
  // A SERVER_BUSY refusal's retry_after_ms, for the close that follows.
  busyRetryAfterMs: number | undefined;
  // The pending redial waits out that hint. Cleared by the next dial.
  busyHold: boolean;

  readonly listeners: Map<string, Set<(payload: never, id?: string) => void>>;
  readonly stateListeners: Set<(state: ConnectionState) => void>;
  // Diagnostic probes observe a fresh server heartbeat; pongs carry no id.
  readonly pongListeners: Set<() => void>;
  // Local send-failure listeners (transport level), notified with the envelope id.
  readonly sendFailureListeners: Set<(id: string, code: string) => void>;
  readonly certMismatchListeners: Set<CertMismatchListener>;
  readonly certFirstUseListeners: Set<CertFirstUseListener>;
  // SERVER_BUSY refusals, which never reach the error listeners.
  readonly serverBusyListeners: Set<() => void>;
  readonly handshakeFaultListeners: Set<() => void>; // bad ready or auth_ok
}

export function createWsState(
  transport: SocketConnection,
  random: () => number,
  clock: NonNullable<ReconnectDependencies["clock"]>,
  dial: (cfg: WsClientConfig) => Promise<void>,
): WsState {
  return {
    transport,
    random,
    clock,
    dial,
    config: null,
    state: "disconnected",
    attemptStartedAt: 0,
    socketGeneration: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    livenessTimer: null,
    livenessDueAt: 0,
    wakeOwner: null,
    lastResumeRecordedAt: null,
    lastWakeKickAt: -Infinity,
    lastActivityAt: Date.now(),
    unansweredPingAt: null,
    intentionalClose: false,
    pendingWake: false,
    certMismatchBlock: false,
    connectFailureCode: null,
    proxyOpen: false,
    lastSeq: 0,
    lastCseq: 0,
    socketId: 0,
    gapResumeTimer: null,
    gapStreak: 0,
    lastGapResumeAt: -Infinity,
    restartRedialAt: null,
    restartOffsetMs: 0,
    busyRetryAfterMs: undefined,
    busyHold: false,
    listeners: new Map(),
    stateListeners: new Set(),
    pongListeners: new Set(),
    sendFailureListeners: new Set(),
    certMismatchListeners: new Set(),
    certFirstUseListeners: new Set(),
    serverBusyListeners: new Set(),
    handshakeFaultListeners: new Set(),
  };
}

export function setState(s: WsState, newState: ConnectionState): void {
  if (s.state !== newState) {
    s.state = newState;
    for (const listener of s.stateListeners) {
      try {
        listener(s.state);
      } catch (err) {
        log.error("State listener error", err);
      }
    }
  }
}

export async function disconnectProxy(s: WsState): Promise<void> {
  const gen = currentGeneration();
  await s.transport.disconnect();
  // A connect() that opened its own proxy while this disconnect was pending
  // owns proxyOpen now; closing it here would wedge the live attempt.
  if (gen === currentGeneration()) s.proxyOpen = false;
}
