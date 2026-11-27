// Reports this client's own speaking ring to the call, so the others see the
// same ring the speaker does (lib/voice/ringAnnounce.ts has the rules;
// lib/voice/roomSpeakers.ts is the listening side). A report goes out when the
// ring changes, and again every second while it is lit. Silence is never
// repeated: a listener that hears nothing falls back to the media server's
// detection, which reads a closed gate's silence as not speaking.

import { RING_REPEAT_MS, type RingState } from "../../lib/voice/ringAnnounce";

export interface RingAnnouncerDeps {
  /** The call this client is in, or null outside one. A new call is a new object. */
  readonly getCall: () => object | null;
  /** The own ring as the input-sensitivity gate decides it, null while no gate runs. */
  readonly getRing: () => RingState;
  /** Report a state to the call. False when it could not be sent. */
  readonly send: (state: RingState) => boolean;
}

export interface RingAnnouncer {
  /** The own ring or the call may have changed: report what the call has not heard. */
  readonly update: () => void;
}

export function createRingAnnouncer(deps: RingAnnouncerDeps): RingAnnouncer {
  /** The call `told` is about. */
  let call: object | null = null;
  /** The last state this call was sent; undefined before the first report. */
  let told: RingState | undefined;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  /** A new call has heard nothing yet. */
  function syncCall(): void {
    const current = deps.getCall();
    if (current === call) return;
    call = current;
    told = undefined;
  }

  /** A call that has heard nothing, or "no verdict", assumes silence: only a
   *  lit ring is news to it. After that every change is. */
  function isNews(state: RingState, repeat: boolean): boolean {
    if (state === true && repeat) return true;
    if (told === undefined || told === null) return state === true;
    return state !== told;
  }

  function stopRepeat(): void {
    if (repeatTimer !== null) clearInterval(repeatTimer);
    repeatTimer = null;
  }

  /** A report that could not be sent changes nothing the call knows: a lit
   *  ring goes out again at the next repeat, a stop at the next update, and
   *  until then a listener drops a ring nobody repeats. */
  function refresh(repeat: boolean): void {
    syncCall();
    const state = call === null ? null : deps.getRing();
    if (state !== true) stopRepeat();
    else if (repeatTimer === null) {
      repeatTimer = setInterval(() => refresh(true), RING_REPEAT_MS);
    }
    if (call === null || !isNews(state, repeat)) return;
    if (deps.send(state)) told = state;
  }

  return { update: () => refresh(false) };
}
