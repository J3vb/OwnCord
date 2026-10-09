import { voiceText } from "../../i18n/voice";

// Backoff between voice joins after a failed one. A join that keeps failing
// before it reaches the SFU (key exchange gave up, connect or setup threw)
// must never cycle voice_join/voice_leave several times a second, however
// fast the join is retried: the next join waits 2 s, doubling per consecutive
// failure up to 30 s. A successful join clears it.

const FIRST_WAIT_MS = 2_000;
const MAX_WAIT_MS = 30_000;

let failures = 0;
let retryAt = 0;
let switched = false;

/** A join attempt failed (or was abandoned by a switch): push the next one back. */
export function noteJoinFailed(now = Date.now(), fromSwitch = false): void {
  failures++;
  switched = fromSwitch;
  retryAt = now + Math.min(FIRST_WAIT_MS * 2 ** (failures - 1), MAX_WAIT_MS);
}

/** A join reached the call: forget earlier failures. */
export function noteJoinSucceeded(): void {
  failures = 0;
  retryAt = 0;
  switched = false;
}

/** How long a new join must still wait, 0 when it may start now. */
export function joinRetryInMs(now = Date.now()): number {
  return Math.max(0, retryAt - now);
}

/** Refusal toast text for a join inside the wait, null when it may start. */
export function joinBackoffText(now = Date.now()): string | null {
  const waitMs = joinRetryInMs(now);
  if (waitMs === 0) return null;
  const seconds = Math.ceil(waitMs / 1000);
  return voiceText(switched ? "join.switchBackoff" : "join.backoff", { seconds });
}
