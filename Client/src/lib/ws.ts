// Step 2.15 — WebSocket Client
// Uses Tauri IPC (ws_connect/ws_send/ws_disconnect commands + events)
// to proxy WSS through Rust, bypassing self-signed cert issues in webview.

import type { ServerMessage, ClientMessage } from "./types";
import { desktop } from "../platform/desktop";
import type {
  SocketConnection,
  SocketConnectionState,
  SocketRetryHint,
} from "../platform/contracts/socket";
import { createLogger } from "./logger";
import { PROTOCOL_EPOCH } from "./protocolTypes";
import { Disposable } from "./disposable";
import { isAndroidHost } from "./hostPlatform";
import { normalizeHostForCertCompare } from "./net/hostNormalize";
import { WsErrorCode } from "@lib/protocolTypes";
import {
  type CertFirstUseListener,
  type CertMismatchListener,
  type CertTofuEvent,
  type ConnectionState,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_MAX_RECONNECT_DELAY,
  GAP_RESUME_QUIET_MS,
  GAP_RESUME_WINDOWS_MS,
  HEARTBEAT_INTERVAL_MS,
  IDENTITY_KEY_WAIT_MS,
  parseStoredFingerprint,
  PONG_GRACE_MS,
  SERVER_SILENCE_RECONNECT_MS,
  uuid,
  WAKE_GAP_MS,
  WAKE_KICK_FLOOR_MS,
  type WsClientConfig,
  type WsListener,
  wsUrlFor,
} from "./wsConfig";
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

/**
 * What this client can render, declared in every `auth` frame. The
 * server withholds the matching channels and frames from a socket that does not
 * declare them, so an older client never shows a broken forum.
 */
const CLIENT_FEATURES: readonly string[] = ["forums"];

/** CLIENT_FEATURES plus `mobile` in the Android app (and only there: a phone's
 *  browser is a web client and counts as a desktop). It tells the server to show
 *  other members the phone shape on this account's status. Read per auth frame,
 *  since the host does not change but tests stub it. */
function clientFeatures(): readonly string[] {
  return isAndroidHost() ? [...CLIENT_FEATURES, "mobile"] : CLIENT_FEATURES;
}

/** Monotonic generation counter — incremented on each connect() to invalidate
 *  stale event listeners from a previous connection attempt. */
let wsGeneration = 0;

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

/**
 * Supplies this device's identity public key (base64) for the host being
 * dialled, so the auth frame can tell the server which key this connection
 * signs its voice announces with (encryption key per device). Resolves null
 * when the key is unavailable (keyring failure, no signed-in user yet): the
 * frame then goes out without it. Registered rather than imported, like
 * `setActiveChannelProvider`, to keep this module free of store and keyring
 * imports.
 */
let identityKeyProvider: ((host: string) => Promise<string | null>) | null = null;

export function setIdentityKeyProvider(
  fn: ((host: string) => Promise<string | null>) | null,
): void {
  identityKeyProvider = fn;
}

// The native socket transport lives behind the `SocketConnection` contract, in
// the desktop implementation; this module takes one transport per client
// from the registry. Everything above that seam stays here: the connection
// state machine, the reconnect policy, the heartbeat, frame parsing and the
// send-failure codes.

/** Dependencies for the backoff policy only; session/heartbeat clocks are unchanged. */
interface ReconnectDependencies {
  /** Uniform sample in [0, 1]. */
  readonly random?: () => number;
  readonly clock?: {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}

export function createWsClient({
  random = Math.random,
  clock = globalThis,
}: ReconnectDependencies = {}) {
  // One transport per client: the certificate listener it registers is
  // app-lifetime state, and a second client (a fresh login, a test) must not
  // inherit a registration the first one made.
  const transport: SocketConnection = desktop.socket.create();
  let config: WsClientConfig | null = null;
  let state: ConnectionState = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Fires when no inbound frame has arrived for
  // SERVER_SILENCE_RECONNECT_MS while the socket still reports open.
  let livenessTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessDueAt = 0;
  // U7d: owns the visibilitychange / online wake-probe listeners.
  // Armed on auth_ok; kept through the reconnect loop and released on
  // an intentional or certificate-blocked close, or disconnect().
  let wakeOwner: Disposable | null = null;
  // When a wake signal last cut a reconnect backoff short.
  let lastWakeKickAt = -Infinity;
  // U4: the last time the app could observe the clock running: a parsed
  // inbound frame (handleMessage), a heartbeat tick (handleWakeSignal), a dial
  // (connect()) or a reconnect-point check (suspendGapExceeded). A jump larger
  // than WAKE_GAP_MS between reads means the process was suspended, so the
  // next dial is marked a wake (pendingWake). Checked by the heartbeat tick,
  // by an inbound frame, and at the reconnect point (the socket already closed
  // before the suspend), so no read discards the evidence of a suspend.
  let lastActivityAt = Date.now();
  // When the oldest heartbeat ping sent since the last inbound frame went out.
  let unansweredPingAt: number | null = null;
  let intentionalClose = false;
  // U4: set when the heartbeat sees a real suspend (a wall-clock gap past
  // WAKE_GAP_MS), at the reconnect point when a close-then-sleep is detected,
  // or when an inbound frame arrives after such a gap. While set, every auth
  // frame carries `wake: true` so the server can refuse a dial that would
  // displace another device's live session. It survives transport-level
  // retries and a user's Retry, and is cleared only by auth_ok (the server
  // accepted the dial), an explicit takeover ("Use here") or disconnect().
  let pendingWake = false;
  let certMismatchBlock = false; // blocks reconnect on TOFU mismatch
  // The distinct failure code from the most recent rejected
  // connect, when the transport could read one (a certificate failure carries
  // `TLS_CERT_UNVERIFIED`). Lets the pre-auth deadline name a certificate
  // failure instead of calling it unreachable. Cleared on each new dial and on
  // a successful connect.
  let connectFailureCode: string | null = null;
  // Mirror of the proxy's own open/closed state, kept here because the
  // send-failure codes below are decided on this side of the seam.
  let proxyOpen = false;
  let lastSeq = 0;
  // The last `cseq` seen on the current socket (0 before the first),
  // the socket it belongs to, and the pending gap resume, if any. A new
  // socket starts the count again and cancels a resume armed on the old one.
  let lastCseq = 0;
  let socketId = 0;
  let gapResumeTimer: ReturnType<typeof setTimeout> | null = null;
  // Back-to-back gap resumes, kept across sockets (auth_ok does not reset it).
  let gapStreak = 0;
  let lastGapResumeAt = -Infinity;
  // P5-S04: an announced restart's redial point (receipt + delay_seconds +
  // this client's random offset in reconnect_spread_ms), so the whole server
  // does not redial into one instant. Cleared by the next dial.
  let restartRedialAt: number | null = null;
  let restartOffsetMs = 0;
  // P5-S04: a SERVER_BUSY refusal's retry_after_ms, for the close that follows.
  let busyRetryAfterMs: number | undefined;
  // P5-S04: the pending redial waits out that hint. Cleared by the next dial.
  let busyHold = false;

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

  // P5-S04: SERVER_BUSY refusals, which never reach the error listeners.
  const serverBusyListeners = new Set<() => void>();

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

  function getReconnectDelay(retryAfterMs?: number): number {
    const maxDelay = config?.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY;
    const ceiling = Math.min(1000 * Math.pow(2, reconnectAttempt), maxDelay);
    // Equal jitter retains a quiet period and keeps spreading even at the cap.
    // Transport hints are minimum waits, bounded by the configured hard cap.
    // Ignore absent/malformed hints; never interpret native error text as one.
    const serverDelay =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.min(retryAfterMs, maxDelay)
        : 0;
    const lower = Math.max(ceiling / 2, serverDelay);
    const upper = Math.max(ceiling, serverDelay);
    return lower + random() * (upper - lower);
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    let lastBeatAt = Date.now();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastBeatAt;
      lastBeatAt = now;
      handleWakeSignal(gap);
    }, HEARTBEAT_INTERVAL_MS);
  }

  // U7d/U4: decide what a long gap since the last wake check means. A gap past
  // WAKE_GAP_MS is a real suspend — the socket may be dead, so mark the next
  // dial a wake (U4) and probe it (U7d). Anything else is an ordinary tick,
  // which pings.
  function handleWakeSignal(gap: number): void {
    // The clock was observed running at this tick, whatever the gap means.
    lastActivityAt = Date.now();
    if (gap > WAKE_GAP_MS) {
      pendingWake = true;
      onWake();
    } else if (proxyOpen) {
      try {
        sendRaw(JSON.stringify({ type: "ping", payload: {} }));
        unansweredPingAt ??= Date.now();
      } catch (err) {
        log.warn("Heartbeat ping send failed", err);
      }
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Re-arm the silence deadline. Called after auth_ok and on every
  // inbound frame, so any traffic — pong, chat, presence — proves the socket
  // is still delivering bytes. A half-open socket delivers nothing, so the
  // timer survives to fire. The wake probe arms the same timer with a shorter
  // deadline once the process may have been suspended.
  function armLiveness(): void {
    unansweredPingAt = null;
    setLivenessTimer(SERVER_SILENCE_RECONNECT_MS);
  }

  function setLivenessTimer(deadlineMs: number): void {
    if (livenessTimer !== null) clearTimeout(livenessTimer);
    livenessDueAt = Date.now() + deadlineMs;
    livenessTimer = setTimeout(() => onLivenessDeadline(deadlineMs), deadlineMs);
  }

  // U7d: a heartbeat wall-clock gap, the screen coming back or the network
  // returning is the earliest evidence the process may have been frozen, so
  // ping now and arm the pong grace as the deadline: an awake server answers
  // within seconds, while a socket that died over the suspend is redialled in
  // 15 s rather than the 60 s silence deadline. An older unanswered ping and a
  // sooner deadline both stand. For a heartbeat gap, handleWakeSignal has
  // already marked the next dial a wake (U4).
  function onWake(): void {
    if (state !== "connected" || !proxyOpen) return;
    sendRaw(JSON.stringify({ type: "ping", payload: {} }));
    unansweredPingAt ??= Date.now();
    setLivenessTimer(Math.max(0, Math.min(PONG_GRACE_MS, livenessDueAt - Date.now())));
  }

  // While the loop waits out a backoff, the network or the screen coming
  // back means the next dial is likely to work now, so dial at once instead of
  // after up to 30 s. It fires the pending timer's own callback, so the U4
  // wake check still runs, and it never dials past a close the loop itself
  // would not retry (disconnect(), auth_error, a TOFU mismatch latch).
  function onWakeSignal(): void {
    if (state === "connected") {
      onWake();
      return;
    }
    if (state !== "reconnecting" || reconnectTimer === null) return;
    if (intentionalClose || certMismatchBlock || !config) return;
    // P5-S04: a restart's spread or a SERVER_BUSY hint is the server pacing
    // its herd, not a network blip; the network coming back does not cut it
    // short.
    if (restartRedialAt !== null || busyHold) return;
    const now = Date.now();
    if (now - lastWakeKickAt < WAKE_KICK_FLOOR_MS) return;
    lastWakeKickAt = now;
    cancelReconnect();
    redial();
  }

  // Armed on auth_ok and kept through the reconnect loop; released on
  // an intentional or certificate-blocked close, or disconnect(). The next
  // auth_ok re-arms them. A signal owns each listener so the lifecycle
  // inventory sees them as owned.
  function armWakeListeners(): void {
    if (wakeOwner !== null) return;
    const owner = new Disposable();
    window.addEventListener("online", onWakeSignal, { signal: owner.signal });
    document.addEventListener(
      "visibilitychange",
      () => document.visibilityState === "visible" && onWakeSignal(),
      { signal: owner.signal },
    );
    wakeOwner = owner;
  }

  function stopWakeListeners(): void {
    wakeOwner?.destroy();
    wakeOwner = null;
  }

  function onLivenessDeadline(deadlineMs: number): void {
    livenessTimer = null;
    if (intentionalClose || !proxyOpen || state !== "connected") return;
    const pingAgeMs = unansweredPingAt === null ? 0 : Date.now() - unansweredPingAt;
    if (pingAgeMs < PONG_GRACE_MS) {
      setLivenessTimer(PONG_GRACE_MS - pingAgeMs);
      return;
    }
    log.warn("No inbound frame within the liveness deadline; forcing reconnect", {
      deadlineMs,
      pingAgeMs,
      host: config?.host ?? "unknown",
    });
    // Tear down like an observed close: the next connect's ws_connect drops
    // the stale Rust sender (which closes the half-open socket) and dials.
    proxyOpen = false;
    stopHeartbeat();
    scheduleReconnect();
  }

  function stopLiveness(): void {
    if (livenessTimer !== null) {
      clearTimeout(livenessTimer);
      livenessTimer = null;
    }
  }

  // U4: whether the wall clock has jumped past the wake threshold since the
  // app last observed it running, AND refreshes that observation. Called at
  // the reconnect point so a wake where the socket already closed (the common
  // "sleeping laptop reclaims the call" case) is marked too, not only a wake
  // the still-running heartbeat notices.
  function suspendGapExceeded(): boolean {
    const now = Date.now();
    const gap = now - lastActivityAt;
    lastActivityAt = now;
    return gap > WAKE_GAP_MS;
  }

  function scheduleReconnect(retryAfterMs?: number): void {
    if (intentionalClose || certMismatchBlock || !config) return;
    // U4: the socket closed, but if the process was suspended in between this
    // is a wake, not a blip — mark the dial and let the server arbitrate.
    if (suspendGapExceeded()) {
      pendingWake = true;
    }
    // One timer at a time: the silence deadline and an observed close
    // can race, and a second timer would redial twice.
    if (reconnectTimer !== null) return;
    const hint = retryAfterMs ?? busyRetryAfterMs;
    busyHold = busyRetryAfterMs !== undefined;
    busyRetryAfterMs = undefined;
    // A drop later than announced still waits this client's own offset, so a
    // late drop does not re-synchronise the herd.
    const delay =
      restartRedialAt !== null
        ? Math.max(restartRedialAt - Date.now(), restartOffsetMs)
        : getReconnectDelay(hint);
    log.info("WebSocket reconnecting", {
      delayMs: delay,
      attempt: reconnectAttempt + 1,
      host: config?.host ?? "unknown",
      lastSeq,
    });
    setState("reconnecting");
    reconnectTimer = clock.setTimeout(redial, delay);
  }

  // The backoff timer's callback, and a wake signal's early redial.
  function redial(): void {
    reconnectTimer = null;
    reconnectAttempt++;
    // U4: the process may have been suspended while this timer was pending
    // (a wake often outlives the backoff window), or a previous wake dial
    // may have failed at the transport — `pendingWake` persists across
    // retries until auth_ok. Mark the dial a wake so the server can refuse
    // it rather than displacing another device.
    if (suspendGapExceeded()) pendingWake = true;
    const nextConfig = config;
    if (!nextConfig) {
      log.warn("Reconnect aborted: missing config");
      setState("disconnected");
      return;
    }
    void connect(nextConfig);
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clock.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function handleMessage(raw: string): void {
    const maxSize = config?.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE;

    let parsed: { type?: string; payload?: unknown; id?: string; seq?: number; cseq?: number };
    try {
      parsed = JSON.parse(raw) as {
        type?: string;
        payload?: unknown;
        id?: string;
        seq?: number;
        cseq?: number;
      };
    } catch {
      // Log the size only — `raw` is the decrypted frame (chat plaintext,
      // usernames) and this line is persisted to the on-disk log.
      log.warn("Failed to parse WS message", { bytes: raw.length });
      return;
    }

    // Any parsed inbound frame proves the socket is delivering bytes — refresh
    // the silence deadline, even for a frame the size guard drops below.
    armLiveness();
    // U4: and that the clock was running, so a later gap is measured from
    // here. A frame is not proof the server still holds this session — it may
    // be a leftover on the socket that died during the suspend — so it can
    // arm the wake marker but never clears it; only auth_ok does.
    if (suspendGapExceeded()) pendingWake = true;

    // Counted before the size guard, so a frame this client drops
    // itself is not read as one the server lost.
    if (typeof parsed.cseq === "number") noteCseq(parsed.cseq);

    // The size guard runs AFTER parsing (raw is already fully materialized
    // in memory either way, so this costs nothing) and exempts the handshake
    // frames: "ready" is the one server frame with no bound — it embeds every
    // member/channel/DM the server knows about — and, unlike a sequenced
    // frame, carries no seq, so nothing ever re-requests it. Dropping it
    // would leave a client that just flipped to "connected" sitting
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

    // P5-S04: the server refused this connect while its ready builds are
    // saturated. Not a user-facing error: the close that follows redials no
    // sooner than the hint.
    if (msg.type === "error" && msg.payload.code === WsErrorCode.SERVER_BUSY) {
      busyRetryAfterMs = msg.payload.retry_after_ms;
      log.info("Server busy, redialling later", { retryAfterMs: busyRetryAfterMs });
      for (const listener of serverBusyListeners) {
        listener();
      }
      return;
    }

    if (msg.type === "server_restart") {
      const delayMs = msg.payload.delay_seconds * 1000;
      restartOffsetMs = random() * Math.max(0, msg.payload.reconnect_spread_ms ?? 0);
      restartRedialAt = delayMs > 0 ? Date.now() + delayMs + restartOffsetMs : null;
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
      // current epoch via the normal seq > lastSeq update.
      if (msg.payload.replay_source === "none") {
        lastSeq = 0;
      }
      setState("connected");
      reconnectAttempt = 0;
      pendingWake = false;
      startHeartbeat();
      armLiveness();
      // U7d: only an authenticated session needs the wake probe, and arming it
      // here keeps the listeners off the connect page (and off tests that
      // never authenticate). disconnect() releases them.
      armWakeListeners();
    }

    dispatch(msg);
  }

  // A `cseq` other than last + 1 means the server skipped a frame it
  // could not deliver and marked this connection for a full ready. One resume
  // per socket is enough: the next socket starts a fresh count.
  function noteCseq(cseq: number): void {
    const expected = lastCseq + 1;
    lastCseq = cseq;
    if (cseq === expected || gapResumeTimer !== null) return;
    if (Date.now() - lastGapResumeAt > GAP_RESUME_QUIET_MS) gapStreak = 0;
    const [min, max] =
      GAP_RESUME_WINDOWS_MS[Math.min(gapStreak, GAP_RESUME_WINDOWS_MS.length - 1)]!;
    const delay = min + random() * (max - min);
    log.info("Missed a live update; resuming to fetch fresh", {
      expected,
      received: cseq,
      delayMs: Math.round(delay),
    });
    const owner = socketId;
    gapResumeTimer = clock.setTimeout(() => {
      gapResumeTimer = null;
      if (owner !== socketId) return;
      resumeForGap();
    }, delay);
  }

  function cancelGapResume(): void {
    if (gapResumeTimer !== null) {
      clock.clearTimeout(gapResumeTimer);
      gapResumeTimer = null;
    }
  }

  // Tear down like the liveness deadline does and redial at once: the jitter
  // already spread this client's resume, and the server answers it with the
  // full ready it owes.
  function resumeForGap(): void {
    if (intentionalClose || certMismatchBlock || !config) return;
    if (state !== "connected" || !proxyOpen) return;
    gapStreak++;
    lastGapResumeAt = Date.now();
    proxyOpen = false;
    stopHeartbeat();
    stopLiveness();
    cancelReconnect();
    setState("reconnecting");
    redial();
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
      stopWakeListeners();
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

  // This device's identity public key for the auth frame, or null. Never
  // rejects and never waits longer than IDENTITY_KEY_WAIT_MS.
  async function resolveIdentityKey(host: string): Promise<string | null> {
    const provider = identityKeyProvider;
    if (provider === null) return null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = clock.setTimeout(() => resolve(null), IDENTITY_KEY_WAIT_MS);
    });
    try {
      return await Promise.race([provider(host).catch(() => null), timeout]);
    } catch {
      return null;
    } finally {
      if (timer !== null) clock.clearTimeout(timer);
    }
  }

  // The transport's proxy lifecycle, turned into the app's reaction: an open
  // proxy is still unauthenticated until `auth_ok` arrives, and a closed one
  // starts the reconnect policy unless the close was intentional.
  function handleTransportState(next: SocketConnectionState, retryHint?: SocketRetryHint): void {
    if (next === "connected") {
      proxyOpen = true;
      socketId++;
      lastCseq = 0;
      cancelGapResume();
      connectFailureCode = null;
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
      // U4: a wake dial carries `wake: true`. The server refuses it
      // (ANOTHER_DEVICE_ACTIVE) when another device holds the session, and
      // accepts it otherwise — so a lone device wakes silently while a woken
      // laptop cannot displace the desktop's call. Omitted unless set, so an
      // ordinary auth frame is byte-identical to before.
      const frame = {
        token: config.token,
        last_seq: lastSeq,
        epoch: PROTOCOL_EPOCH,
        ...(activeChannelId !== null ? { active_channel_id: activeChannelId } : {}),
        ...(pendingWake ? { wake: true } : {}),
        features: clientFeatures(),
      };
      if (identityKeyProvider === null) {
        send({ type: "auth", payload: frame });
        return;
      }
      // The key is looked up asynchronously, so this attempt must still own
      // the socket when the lookup settles: a newer socket, a disconnect() or
      // a newer connect() makes this frame stale and it is dropped.
      const attemptSocketId = socketId;
      const attemptGen = wsGeneration;
      void resolveIdentityKey(config.host).then((identityKey) => {
        if (socketId !== attemptSocketId || wsGeneration !== attemptGen || !proxyOpen) return;
        send({
          type: "auth",
          payload: {
            ...frame,
            ...(identityKey !== null ? { identity_public_key: identityKey } : {}),
          },
        });
      });
    } else if (next === "disconnected") {
      proxyOpen = false;
      cancelGapResume();
      // Record the transport's distinct failure code, if any: a failed connect
      // can carry one (a certificate failure today), and a plain close clears
      // it. The pre-auth deadline reads this to name the failure.
      connectFailureCode = retryHint?.errorCode ?? null;
      log.info("WebSocket closed", {
        host: config?.host ?? "unknown",
        intentional: intentionalClose,
        certBlocked: certMismatchBlock,
      });
      stopHeartbeat();
      stopLiveness();
      // A close the loop will retry keeps the wake listeners, so the
      // network or the screen coming back can cut the backoff short.
      if (intentionalClose || certMismatchBlock) stopWakeListeners();
      if (!intentionalClose) {
        scheduleReconnect(retryHint?.retryAfterMs);
      } else {
        setState("disconnected");
      }
    }
    // "connecting" — this client sets that state itself before asking the
    // transport to dial, so a report here is already reflected.
  }

  async function connect(cfg: WsClientConfig, takeover = false): Promise<void> {
    wsGeneration++;
    // Captured so a disconnect() landing mid-attempt can be detected on resume
    // — disconnect() bumps wsGeneration too, so a mismatch here means this
    // attempt was cancelled.
    const gen = wsGeneration;
    config = cfg;
    intentionalClose = false;
    // U4: only an explicit takeover ("Use here") drops the wake marker. Any
    // other connect — the reconnect loop, Retry, a certificate re-dial — keeps
    // it, so the server can still refuse a dial that would displace another
    // device.
    if (takeover) pendingWake = false;
    lastActivityAt = Date.now();
    // Belt-and-braces: a fresh connect (even one not routed through
    // disconnect(), e.g. a suppressed-modal cert latch from an unrelated
    // host) must not inherit a stale block from a previous connection.
    certMismatchBlock = false;
    connectFailureCode = null;
    restartRedialAt = null;
    busyRetryAfterMs = undefined;
    busyHold = false;
    cancelReconnect();
    cancelGapResume();
    stopLiveness();

    setState("connecting");

    const url = wsUrlFor(cfg.host);
    log.info("WebSocket connecting", {
      url,
      isReconnect: reconnectAttempt > 0,
      attempt: reconnectAttempt,
    });

    try {
      await transport.connect({
        url,
        token: cfg.token,
        maxReconnectDelayMs: cfg.maxReconnectDelayMs,
        maxMessageSizeBytes: cfg.maxMessageSizeBytes,
      });
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
    const gen = wsGeneration;
    await transport.disconnect();
    // A connect() that opened its own proxy while this disconnect was pending
    // owns proxyOpen now; closing it here would wedge the live attempt.
    if (gen === wsGeneration) proxyOpen = false;
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
    pendingWake = false;
    restartRedialAt = null;
    busyRetryAfterMs = undefined;
    busyHold = false;
    cancelReconnect();
    cancelGapResume();
    stopHeartbeat();
    stopLiveness();
    stopWakeListeners();
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
    /** `takeover` is the user's informed choice to take the session back
     * from another device ("Use here"); it drops any pending wake marker. */
    connect(cfg: WsClientConfig, opts?: { readonly takeover?: boolean }): void {
      void connect(cfg, opts?.takeover === true);
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
          // i18n-exempt: internal ping liveness guard, never rendered
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
          // i18n-exempt: internal ping liveness guard, never rendered
          if (next !== "connected") fail(new Error("The application connection changed."));
        };
        const onPong = (): void => {
          if (generation !== wsGeneration) {
            // i18n-exempt: internal ping liveness guard, never rendered
            fail(new Error("The application connection changed."));
            return;
          }
          cleanup();
          resolve();
        };
        const timer = setTimeout(
          // i18n-exempt: internal ping liveness guard, never rendered
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

    /** Register a listener for SERVER_BUSY refusals (P5-S04). */
    onServerBusy(listener: () => void): () => void {
      serverBusyListeners.add(listener);
      return () => serverBusyListeners.delete(listener);
    },

    /** Register a listener for TOFU certificate mismatch events. */
    onCertMismatch(listener: CertMismatchListener): () => void {
      certMismatchListeners.add(listener);
      return () => certMismatchListeners.delete(listener);
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
        certMismatchBlock = false;
      }
    },

    getState(): ConnectionState {
      return state;
    },

    /** The distinct failure code from the most recent rejected connect, when
     *  the transport reported one (a certificate failure carries
     *  `TLS_CERT_UNVERIFIED`); null otherwise. Read by the pre-auth deadline so
     *  it can name a certificate failure instead of calling it unreachable. */
    getConnectFailureCode(): string | null {
      return connectFailureCode;
    },

    /** @internal for testing */
    _getWs(): WebSocket | null {
      return null;
    },
  };
}

export type WsClient = ReturnType<typeof createWsClient>;
