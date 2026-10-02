/**
 * Incoming-call ring state.
 *
 * A "call" in a DM is not a server-side object — it is somebody being present
 * in that DM's voice channel. Ringing is the ephemeral nudge that says "come
 * look", and this module is the whole of its client-side lifetime:
 *
 *      (none) --call_incoming--> ringing --accept---> (none)  [+ join voice]
 *                                       --decline--> (none)  [+ call_decline]
 *                                       --timeout--> (none)   after 30s [+ missed]
 *                                       --ringer left-> (none)
 *
 * It is kept apart from the banner that draws it because the interesting part
 * is the transitions, and a statechart with no DOM in it is a statechart that
 * can be tested without one. Every exit runs through `stopRinging`, so there
 * is exactly one place that can leave the chime playing.
 */

export const RING_TIMEOUT_MS = 30_000;

/** A ring in flight. */
export interface RingState {
  readonly channelId: number;
  readonly fromUserId: number;
  readonly fromUsername: string;
}

/** Why a ring ended. Reported so the caller knows whether to answer back. */
export type RingEndReason = "accepted" | "declined" | "timeout" | "ringer-left" | "superseded";

export interface RingControllerOptions {
  /** Draw (or clear, with null) the incoming-call banner. */
  readonly onRingStateChange: (state: RingState | null) => void;
  /** Start/stop the repeating chime. */
  readonly onChime: (playing: boolean) => void;
  /** Join the DM's voice channel — the accept action. */
  readonly onAccept: (channelId: number) => void;
  /** Tell the ringer we are not picking up. Not sent on timeout: a timeout is
   *  "nobody was there", and the ringer's own 30s window covers it. */
  readonly onDecline: (channelId: number) => void;
  /** A new ring began: not a redial of the ring already on screen. The OS
   *  notification and the attention request hang off this, once per ring. */
  readonly onRingStart?: (state: RingState) => void;
  /** The ring ran out with nobody answering (DP-24). Only the timeout: an
   *  accept, a decline, the ringer leaving or a newer call is not a miss. */
  readonly onMissed?: (state: RingState) => void;
  /** Test seam for the 30s timer. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RingController {
  /** A call_incoming arrived. */
  readonly incoming: (state: RingState) => void;
  /** The user accepted. No-op when nothing is ringing. */
  readonly accept: () => void;
  /** The user declined. No-op when nothing is ringing. */
  readonly decline: () => void;
  /**
   * A call_declined arrived, or the ringer left the DM's voice channel — both
   * mean "stop ringing for this channel". Ignored when the current ring is for
   * a different channel, so a stale signal cannot silence a live call.
   */
  readonly cancel: (channelId: number, reason?: RingEndReason) => void;
  /** The ring in flight, or null. */
  readonly current: () => RingState | null;
  /** Tear down: stops the chime and the timer. */
  readonly destroy: () => void;
}

export function createRingController(opts: RingControllerOptions): RingController {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  let state: RingState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stopRinging(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (state === null) return;
    state = null;
    opts.onChime(false);
    opts.onRingStateChange(null);
  }

  function incoming(next: RingState): void {
    // A second ring replaces the first rather than queueing: two banners at
    // once is two decisions the user did not ask to make, and the newer ring
    // is the one they can still answer.
    if (state !== null && state.channelId !== next.channelId) {
      stopRinging();
    }
    const redial = state !== null;
    state = next;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      // No decline goes back to the ringer (see onDecline's comment), but the
      // callee is told they missed it.
      const missed = state;
      stopRinging();
      if (missed !== null) opts.onMissed?.(missed);
    }, RING_TIMEOUT_MS);
    opts.onRingStateChange(next);
    opts.onChime(true);
    if (!redial) opts.onRingStart?.(next);
  }

  function accept(): void {
    const active = state;
    if (active === null) return;
    stopRinging();
    opts.onAccept(active.channelId);
  }

  function decline(): void {
    const active = state;
    if (active === null) return;
    stopRinging();
    opts.onDecline(active.channelId);
  }

  function cancel(channelId: number): void {
    if (state === null || state.channelId !== channelId) return;
    stopRinging();
  }

  return {
    incoming,
    accept,
    decline,
    cancel,
    current: () => state,
    destroy: () => stopRinging(),
  };
}

/**
 * Outgoing-call state: the caller's side of a ring.
 *
 *      (none) --start--> ringing --every callee declined--> declined
 *                                --30s, nobody joined-----> no-answer
 *      any    --clear--> (none)   someone joined, or the caller left
 *
 * The server holds no call record, so the caller's only signals are the
 * callees' call_declined frames and the room filling up; everything else is
 * this client's own 30s window, the same RING_TIMEOUT_MS the callees ring for.
 * A declined or unanswered call leaves the caller in the room (Ring again),
 * so `clear` is the only way back to (none).
 */
export type OutgoingCallPhase = "ringing" | "declined" | "no-answer";

export interface OutgoingCallState {
  readonly channelId: number;
  readonly phase: OutgoingCallPhase;
  /** Callees who have neither joined nor declined. */
  readonly pending: readonly number[];
}

export interface OutgoingCallOptions {
  readonly onChange: (state: OutgoingCallState | null) => void;
  /** The caller's ringback: true while `phase === "ringing"`, false the moment
   *  the ring ends for any reason (DP-25). Never true after `clear`. */
  readonly onRingback?: (playing: boolean) => void;
  /** Test seam for the 30s timer. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface OutgoingCall {
  /** A ring went out (or went out again) to these callees. */
  readonly start: (channelId: number, calleeIds: readonly number[]) => void;
  /** A callee's call_declined arrived. Ignored for any other channel. */
  readonly declined: (channelId: number, userId: number) => void;
  /** Someone joined, or the caller left: the ring is over. */
  readonly clear: () => void;
  readonly current: () => OutgoingCallState | null;
  readonly destroy: () => void;
}

export function createOutgoingCall(opts: OutgoingCallOptions): OutgoingCall {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  let state: OutgoingCallState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the ringback is currently playing, so it is toggled once per
   *  phase change and not on every pending update. */
  let ringbackPlaying = false;

  function stopTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function set(next: OutgoingCallState | null): void {
    state = next;
    const playing = next?.phase === "ringing";
    if (playing !== ringbackPlaying) {
      ringbackPlaying = playing;
      opts.onRingback?.(playing);
    }
    opts.onChange(next);
  }

  function start(channelId: number, calleeIds: readonly number[]): void {
    stopTimer();
    timer = setTimer(() => {
      timer = null;
      if (state?.phase === "ringing") set({ ...state, phase: "no-answer" });
    }, RING_TIMEOUT_MS);
    set({ channelId, phase: "ringing", pending: [...calleeIds] });
  }

  function declined(channelId: number, userId: number): void {
    if (state === null || state.channelId !== channelId || state.phase !== "ringing") return;
    const pending = state.pending.filter((id) => id !== userId);
    if (pending.length === state.pending.length) return;
    // In a group a decline only takes that person off the list: the call
    // is still ringing for everyone else.
    if (pending.length > 0) {
      set({ ...state, pending });
      return;
    }
    stopTimer();
    set({ ...state, phase: "declined", pending });
  }

  function clear(): void {
    stopTimer();
    if (state !== null) set(null);
  }

  return { start, declined, clear, current: () => state, destroy: clear };
}
