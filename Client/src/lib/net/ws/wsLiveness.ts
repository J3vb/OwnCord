// Heartbeat, silence deadline and wake probes. Every timer handle lives on the
// client's state and is cleared through wsTimers.

import { createLogger } from "../../logger";
import { recordEvent } from "../../diagnostics/eventSink";
import { Disposable } from "../../disposable";
import {
  HEARTBEAT_INTERVAL_MS,
  PONG_GRACE_MS,
  SERVER_SILENCE_RECONNECT_MS,
  WAKE_GAP_MS,
  WAKE_KICK_FLOOR_MS,
} from "../../wsConfig";
import { redial, scheduleReconnect } from "./wsReconnect";
import { sendRaw } from "./wsSend";
import { cancelReconnect, noteResumed } from "./wsTimers";
import type { WsState } from "./wsState";

const log = createLogger("ws");

const PING = JSON.stringify({ type: "ping", payload: {} });

export function stopHeartbeat(s: WsState): void {
  if (s.heartbeatTimer !== null) {
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
  }
}

export function stopLiveness(s: WsState): void {
  if (s.livenessTimer !== null) {
    clearTimeout(s.livenessTimer);
    s.livenessTimer = null;
  }
}

export function startHeartbeat(s: WsState): void {
  stopHeartbeat(s);
  let lastBeatAt = Date.now();
  s.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeatAt;
    lastBeatAt = now;
    handleWakeSignal(s, gap);
  }, HEARTBEAT_INTERVAL_MS);
}

// Decide what a long gap since the last wake check means. A gap past
// WAKE_GAP_MS is a real suspend — the socket may be dead, so mark the next
// dial a wake and probe it. Anything else is an ordinary tick, which pings.
function handleWakeSignal(s: WsState, gap: number): void {
  // The clock was observed running at this tick, whatever the gap means.
  s.lastActivityAt = Date.now();
  if (gap > WAKE_GAP_MS) {
    s.pendingWake = true;
    noteResumed(s, gap);
    onWake(s);
  } else if (s.proxyOpen) {
    try {
      sendRaw(s, PING);
      s.unansweredPingAt ??= Date.now();
    } catch (err) {
      log.warn("Heartbeat ping send failed", err);
    }
  }
}

// Re-arm the silence deadline. Called after auth_ok and on every inbound frame,
// so any traffic — pong, chat, presence — proves the socket is still
// delivering bytes. A half-open socket delivers nothing, so the timer survives
// to fire.
export function armLiveness(s: WsState): void {
  s.unansweredPingAt = null;
  setLivenessTimer(s, SERVER_SILENCE_RECONNECT_MS);
}

function setLivenessTimer(s: WsState, deadlineMs: number): void {
  if (s.livenessTimer !== null) clearTimeout(s.livenessTimer);
  s.livenessDueAt = Date.now() + deadlineMs;
  s.livenessTimer = setTimeout(() => onLivenessDeadline(s, deadlineMs), deadlineMs);
}

// A heartbeat wall-clock gap, the screen coming back or the network returning
// is the earliest evidence the process may have been frozen, so ping now and
// arm the pong grace as the deadline. An older unanswered ping and a sooner
// deadline both stand.
function onWake(s: WsState): void {
  if (s.state !== "connected" || !s.proxyOpen) return;
  sendRaw(s, PING);
  s.unansweredPingAt ??= Date.now();
  setLivenessTimer(s, Math.max(0, Math.min(PONG_GRACE_MS, s.livenessDueAt - Date.now())));
}

// While the loop waits out a backoff, the network or the screen coming back
// means the next dial is likely to work now, so dial at once. It never dials
// past a close the loop itself would not retry (disconnect(), auth_error, a
// TOFU mismatch latch).
function onWakeSignal(s: WsState): void {
  if (s.state === "connected") {
    onWake(s);
    return;
  }
  if (s.state !== "reconnecting" || s.reconnectTimer === null) return;
  if (s.intentionalClose || s.certMismatchBlock || !s.config) return;
  // A restart's spread or a SERVER_BUSY hint is the server pacing its herd, not
  // a network blip; the network coming back does not cut it short.
  if (s.restartRedialAt !== null || s.busyHold) return;
  const now = Date.now();
  if (now - s.lastWakeKickAt < WAKE_KICK_FLOOR_MS) return;
  s.lastWakeKickAt = now;
  cancelReconnect(s);
  redial(s);
}

// Armed on auth_ok and kept through the reconnect loop; released on an
// intentional or certificate-blocked close, or disconnect(). The next auth_ok
// re-arms them. A signal owns each listener so the lifecycle inventory sees
// them as owned.
export function armWakeListeners(s: WsState): void {
  if (s.wakeOwner !== null) return;
  const owner = new Disposable();
  // The same two signals go into the diagnostic event log as app facts.
  window.addEventListener(
    "online",
    () => {
      recordEvent("app.network", { state: "online" });
      onWakeSignal(s);
    },
    { signal: owner.signal },
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      const visible = document.visibilityState === "visible";
      recordEvent("app.visibility", { state: visible ? "visible" : "hidden" });
      if (visible) onWakeSignal(s);
    },
    { signal: owner.signal },
  );
  s.wakeOwner = owner;
}

function onLivenessDeadline(s: WsState, deadlineMs: number): void {
  s.livenessTimer = null;
  if (s.intentionalClose || !s.proxyOpen || s.state !== "connected") return;
  const pingAgeMs = s.unansweredPingAt === null ? 0 : Date.now() - s.unansweredPingAt;
  if (pingAgeMs < PONG_GRACE_MS) {
    setLivenessTimer(s, PONG_GRACE_MS - pingAgeMs);
    return;
  }
  log.warn("No inbound frame within the liveness deadline; forcing reconnect", {
    deadlineMs,
    pingAgeMs,
    host: s.config?.host ?? "unknown",
  });
  // Tear down like an observed close: the next connect's ws_connect drops
  // the stale Rust sender (which closes the half-open socket) and dials.
  s.proxyOpen = false;
  stopHeartbeat(s);
  scheduleReconnect(s);
}
