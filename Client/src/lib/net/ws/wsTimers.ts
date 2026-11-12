// Stop and cancel operations on a client's timers and wake listeners, plus the
// suspend-gap clock check. Leaf module: it depends on state only, so the
// reconnect, liveness and gap-resume modules can all import it.

import { recordEvent } from "../../diagnostics/eventSink";
import { WAKE_GAP_MS } from "../../wsConfig";
import type { WsState } from "./wsState";

export function stopWakeListeners(s: WsState): void {
  s.wakeOwner?.destroy();
  s.wakeOwner = null;
}

export function cancelReconnect(s: WsState): void {
  if (s.reconnectTimer !== null) {
    s.clock.clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
}

export function cancelGapResume(s: WsState): void {
  if (s.gapResumeTimer !== null) {
    s.clock.clearTimeout(s.gapResumeTimer);
    s.gapResumeTimer = null;
  }
}

// The heartbeat and the reconnect point can both see the same suspend; a
// gap the last record already covers is the same sleep, recorded once.
export function noteResumed(s: WsState, gap: number): void {
  const now = Date.now();
  if (s.lastResumeRecordedAt !== null && now - s.lastResumeRecordedAt < gap) return;
  s.lastResumeRecordedAt = now;
  recordEvent("app.resumed", { asleep_ms: gap });
}

// Whether the wall clock has jumped past the wake threshold since the app last
// observed it running, AND refreshes that observation. Called at the reconnect
// point so a wake where the socket already closed is marked too, not only a
// wake the still-running heartbeat notices.
export function suspendGapExceeded(s: WsState): boolean {
  const now = Date.now();
  const gap = now - s.lastActivityAt;
  s.lastActivityAt = now;
  if (gap <= WAKE_GAP_MS) return false;
  noteResumed(s, gap);
  return true;
}
