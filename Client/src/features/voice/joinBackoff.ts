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

/** True when the current wait was armed by a channel switch, not a failed join. */
export function joinBackoffFromSwitch(): boolean {
  return switched;
}
