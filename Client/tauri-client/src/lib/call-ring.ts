/**
 * Incoming-call ring state.
 *
 * A "call" in a DM is not a server-side object — it is somebody being present
 * in that DM's voice channel. Ringing is the ephemeral nudge that says "come
 * look", and this module is the whole of its client-side lifetime:
 *
 *      (none) --call_incoming--> ringing --accept---> (none)  [+ join voice]
 *                                       --decline--> (none)  [+ call_decline]
 *                                       --timeout--> (none)   after 30s
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
    state = next;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      // Timeout is silent by design — see onDecline's comment.
      stopRinging();
    }, RING_TIMEOUT_MS);
    opts.onRingStateChange(next);
    opts.onChime(true);
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
