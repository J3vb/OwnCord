// Gap resume: a `cseq` other than last + 1 means the server skipped a frame it
// could not deliver and marked this connection for a full ready. The resume
// timer belongs to the socket that armed it and does nothing once a newer
// socket exists.

import { createLogger } from "../../logger";
import { planGapResume } from "../gapResume";
import { redial } from "./wsReconnect";
import { stopHeartbeat, stopLiveness } from "./wsLiveness";
import { cancelReconnect } from "./wsTimers";
import { setState, type WsState } from "./wsState";

const log = createLogger("ws");

// One resume per socket is enough: the next socket starts a fresh count.
export function noteCseq(s: WsState, cseq: number): void {
  const expected = s.lastCseq + 1;
  s.lastCseq = cseq;
  if (cseq !== expected) armGapResume(s, { expected, received: cseq });
}

export function armGapResume(s: WsState, detail: object): void {
  if (s.gapResumeTimer !== null) return;
  const plan = planGapResume(s.gapStreak, s.lastGapResumeAt, Date.now(), s.random());
  s.gapStreak = plan.streak;
  log.info("Missed a live update; resuming to fetch fresh", {
    ...detail,
    delayMs: Math.round(plan.delay),
  });
  const owner = s.socketId;
  // A rejected frame was already counted into the resume point, so resuming from
  // it would replay nothing: that redial asks for the full state instead.
  const fresh = "rejected" in detail;
  s.gapResumeTimer = s.clock.setTimeout(() => {
    s.gapResumeTimer = null;
    if (owner !== s.socketId) return;
    resumeForGap(s, fresh);
  }, plan.delay);
}

// Tear down like the liveness deadline does and redial at once: the jitter
// already spread this client's resume, and the server answers it with the
// full ready it owes. `fresh` drops the resume point (and so the open channel
// in the auth frame) so that ready is a full one. The streak and the time of
// the last resume are kept, so a server that keeps sending the bad frame is
// redialled at growing intervals, never faster than the last window.
function resumeForGap(s: WsState, fresh: boolean): void {
  if (s.intentionalClose || s.certMismatchBlock || !s.config) return;
  if (s.state !== "connected" || !s.proxyOpen) return;
  if (fresh) s.lastSeq = 0;
  s.gapStreak++;
  s.lastGapResumeAt = Date.now();
  s.proxyOpen = false;
  stopHeartbeat(s);
  stopLiveness(s);
  cancelReconnect(s);
  setState(s, "reconnecting");
  redial(s);
}
