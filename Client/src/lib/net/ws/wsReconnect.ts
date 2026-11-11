// The reconnect policy: backoff delay, the one pending redial timer, and the
// redial itself. The timer's callback re-checks nothing about ownership on its
// own: connect() takes a fresh generation, which is what supersedes the attempt
// that scheduled it.

import { createLogger } from "../../logger";
import { recordEvent } from "../../diagnostics/eventSink";
import { DEFAULT_MAX_RECONNECT_DELAY } from "../../wsConfig";
import { currentGeneration } from "./generation";
import { suspendGapExceeded } from "./wsTimers";
import { setState, type WsState } from "./wsState";

const log = createLogger("ws");

export function getReconnectDelay(s: WsState, retryAfterMs?: number): number {
  const maxDelay = s.config?.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY;
  const ceiling = Math.min(1000 * Math.pow(2, s.reconnectAttempt), maxDelay);
  // Equal jitter retains a quiet period and keeps spreading even at the cap.
  // Transport hints are minimum waits, bounded by the configured hard cap.
  // Ignore absent/malformed hints; never interpret native error text as one.
  const serverDelay =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? Math.min(retryAfterMs, maxDelay)
      : 0;
  const lower = Math.max(ceiling / 2, serverDelay);
  const upper = Math.max(ceiling, serverDelay);
  return lower + s.random() * (upper - lower);
}

export function scheduleReconnect(s: WsState, retryAfterMs?: number): void {
  if (s.intentionalClose || s.certMismatchBlock || !s.config) return;
  // The socket closed, but if the process was suspended in between this
  // is a wake, not a blip — mark the dial and let the server arbitrate.
  if (suspendGapExceeded(s)) {
    s.pendingWake = true;
  }
  // One timer at a time: the silence deadline and an observed close
  // can race, and a second timer would redial twice.
  if (s.reconnectTimer !== null) return;
  const hint = retryAfterMs ?? s.busyRetryAfterMs;
  s.busyHold = s.busyRetryAfterMs !== undefined;
  s.busyRetryAfterMs = undefined;
  // A drop later than announced still waits this client's own offset, so a
  // late drop does not re-synchronise the herd.
  const delay =
    s.restartRedialAt !== null
      ? Math.max(s.restartRedialAt - Date.now(), s.restartOffsetMs)
      : getReconnectDelay(s, hint);
  log.info("WebSocket reconnecting", {
    delayMs: delay,
    attempt: s.reconnectAttempt + 1,
    host: s.config?.host ?? "unknown",
    lastSeq: s.lastSeq,
  });
  setState(s, "reconnecting");
  recordEvent("ws.reconnect_scheduled", {
    generation: currentGeneration(),
    attempt: s.reconnectAttempt + 1,
    delay_ms: delay,
  });
  s.reconnectTimer = s.clock.setTimeout(() => redial(s), delay);
}

// The backoff timer's callback, and a wake signal's early redial.
export function redial(s: WsState): void {
  s.reconnectTimer = null;
  s.reconnectAttempt++;
  // The process may have been suspended while this timer was pending
  // (a wake often outlives the backoff window), or a previous wake dial
  // may have failed at the transport — `pendingWake` persists across
  // retries until auth_ok. Mark the dial a wake so the server can refuse
  // it rather than displacing another device.
  if (suspendGapExceeded(s)) s.pendingWake = true;
  const nextConfig = s.config;
  if (!nextConfig) {
    log.warn("Reconnect aborted: missing config");
    setState(s, "disconnected");
    return;
  }
  void s.dial(nextConfig);
}
