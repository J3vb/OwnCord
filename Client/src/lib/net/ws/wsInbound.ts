// Inbound frames: admit (parse, liveness, size guard, sequence bookkeeping),
// answer heartbeats, run the payload shape checks, route the control frames
// that steer the connection, and hand everything else to the listeners.

import type { ServerMessage } from "../../types";
import { createLogger } from "../../logger";
import { recordEvent } from "../../diagnostics/eventSink";
import { WsErrorCode } from "../../protocolTypes";
import { DEFAULT_MAX_MESSAGE_SIZE } from "../../wsConfig";
import {
  callAll,
  parseFrame,
  readServerFrame,
  reportRejectedFrame,
  type RawFrame,
} from "../wsFrame";
import { currentGeneration } from "./generation";
import { armGapResume, noteCseq } from "./wsGapResume";
import {
  armLiveness,
  armWakeListeners,
  startHeartbeat,
  stopHeartbeat,
  stopLiveness,
} from "./wsLiveness";
import { disconnectProxy, setState, type WsState } from "./wsState";
import { cancelGapResume, stopWakeListeners, suspendGapExceeded } from "./wsTimers";

const log = createLogger("ws");

interface AdmittedFrame {
  readonly parsed: RawFrame;
  readonly seq: number;
}

// Parse and bookkeep one raw frame. Null means the frame was dropped here.
function admitFrame(s: WsState, raw: string): AdmittedFrame | null {
  const maxSize = s.config?.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE;

  const parsed = parseFrame(raw);
  if (parsed === null) {
    // Log the size only — `raw` is the decrypted frame (chat plaintext,
    // usernames) and this line is persisted to the on-disk log.
    log.warn("Failed to parse WS message", { bytes: raw.length });
    return null;
  }

  // Any inbound object frame proves the socket is delivering bytes — refresh
  // the silence deadline, even for a frame the size guard drops below.
  armLiveness(s);
  // And that the clock was running, so a later gap is measured from here. A
  // frame is not proof the server still holds this session — it may be a
  // leftover on the socket that died during the suspend — so it can arm the
  // wake marker but never clears it; only auth_ok does.
  if (suspendGapExceeded(s)) s.pendingWake = true;

  // Counted before the size guard, so a frame this client drops
  // itself is not read as one the server lost.
  if (typeof parsed.cseq === "number") noteCseq(s, parsed.cseq);

  // The size guard runs AFTER parsing (raw is already fully materialized, so
  // this costs nothing) and exempts the handshake frames: "ready" embeds every
  // member/channel/DM the server knows, so it has no bound, and carries no seq,
  // so nothing re-requests it; dropping it would leave a "connected" client on
  // empty stores with no recovery. "auth_ok" can embed a long username/motd
  // and is equally unrecoverable. Every other message type keeps the strict bound.
  if (raw.length > maxSize && parsed.type !== "ready" && parsed.type !== "auth_ok") {
    log.warn("Message exceeds size limit, dropping", { size: raw.length, type: parsed.type });
    return null;
  }

  // Track the highest sequence number for reconnection replay.
  const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
  if (seq > s.lastSeq) {
    s.lastSeq = seq;
  }
  return { parsed, seq };
}

export function handleMessage(s: WsState, raw: string): void {
  const admitted = admitFrame(s, raw);
  if (admitted === null) return;
  const { parsed, seq } = admitted;

  // Heartbeats have no payload and do not belong in the domain dispatcher.
  if (parsed.type === "pong") {
    for (const listener of s.pongListeners) listener();
    return;
  }

  const read = readServerFrame(parsed);
  if (read.kind !== "message") {
    onRejected(s, reportRejectedFrame(read, raw.length, seq > 0));
    return;
  }
  const msg = read.msg;

  log.debug("WS ←", { type: msg.type, id: msg.id });

  if (routeControlFrame(s, msg)) return;
  dispatch(s, msg);
}

// The frames that steer the connection itself. True means the frame ends here
// and never reaches the listeners.
function routeControlFrame(s: WsState, msg: ServerMessage): boolean {
  switch (msg.type) {
    case "auth_error":
      // Non-recoverable.
      log.error("Authentication failed", { message: msg.payload.message });
      s.intentionalClose = true;
      dispatch(s, msg);
      void disconnectProxy(s);
      setState(s, "disconnected");
      return true;
    case "error":
      return msg.payload.code === WsErrorCode.SERVER_BUSY && onServerBusy(s, msg.payload);
    case "server_restart":
      noteServerRestart(s, msg.payload);
      return false;
    case "auth_ok":
      onAuthOk(s, msg.payload);
      return false;
    default:
      return false;
  }
}

// The server refused this connect while its ready builds are saturated. Not a
// user-facing error: the close that follows redials no sooner than the hint.
function onServerBusy(s: WsState, payload: { retry_after_ms?: number }): true {
  s.busyRetryAfterMs = payload.retry_after_ms;
  log.info("Server busy, redialling later", { retryAfterMs: s.busyRetryAfterMs });
  for (const listener of s.serverBusyListeners) {
    listener();
  }
  return true;
}

function noteServerRestart(
  s: WsState,
  payload: { delay_seconds: number; reconnect_spread_ms?: number },
): void {
  const delayMs = payload.delay_seconds * 1000;
  s.restartOffsetMs = s.random() * Math.max(0, payload.reconnect_spread_ms ?? 0);
  s.restartRedialAt = delayMs > 0 ? Date.now() + delayMs + s.restartOffsetMs : null;
}

// auth_ok — mark as connected.
function onAuthOk(s: WsState, payload: { replay_source?: string }): void {
  if (s.reconnectAttempt > 0) {
    log.info("WebSocket reconnected successfully", {
      afterAttempts: s.reconnectAttempt,
      host: s.config?.host ?? "unknown",
      lastSeq: s.lastSeq,
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
  if (payload.replay_source === "none") {
    s.lastSeq = 0;
  }
  setState(s, "connected");
  recordEvent("ws.ready", {
    generation: currentGeneration(),
    after_ms: s.attemptStartedAt > 0 ? Date.now() - s.attemptStartedAt : null,
  });
  s.reconnectAttempt = 0;
  s.pendingWake = false;
  startHeartbeat(s);
  armLiveness(s);
  // Only an authenticated session needs the wake probe, and arming it here
  // keeps the listeners off the connect page (and off tests that never
  // authenticate). disconnect() releases them.
  armWakeListeners(s);
}

// A handshake frame of the wrong shape cannot be asked for again: end the connect
// like auth_error, stopping every timer here (the close arrives stale). A lost
// sequenced frame is made up for by a fresh state.
function onRejected(s: WsState, verdict: ReturnType<typeof reportRejectedFrame>): void {
  // The rejected frame was already counted into the resume point, so resuming
  // from it would replay nothing: this redial asks for the full state instead.
  if (verdict === "resync") armGapResume(s, { rejected: "shape" }, true);
  if (verdict !== "fatal") return;
  s.intentionalClose = true;
  stopHeartbeat(s);
  stopLiveness(s);
  stopWakeListeners(s);
  cancelGapResume(s);
  callAll(s.handshakeFaultListeners, (err) => log.error("Handshake fault listener error", err));
  void disconnectProxy(s);
  setState(s, "disconnected");
}

function dispatch(s: WsState, msg: ServerMessage): void {
  const typeListeners = s.listeners.get(msg.type);
  if (!typeListeners || typeListeners.size === 0) {
    log.debug("WS dispatch: no listeners", { type: msg.type });
    return;
  }
  for (const listener of typeListeners) {
    try {
      listener(msg.payload as never, msg.id); // the set holds msg.type's listeners
    } catch (err) {
      log.error(`Listener error for ${msg.type}`, err);
    }
  }
}
