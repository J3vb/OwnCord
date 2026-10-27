import { loadPref } from "./preferences";

/** The device-local setting "Share the game you are playing" (WP 8.3). */
export const GAME_ACTIVITY_PREF_KEY = "shareGameActivity";

/** Whether this device shares the game being played. On unless turned off. */
export function isGameActivityShared(): boolean {
  return loadPref<boolean>(GAME_ACTIVITY_PREF_KEY, true);
}

/**
 * The seam between the dispatcher's `error` chain and the game activity loop
 * (WP 8.3), and the one place the sharing setting is read.
 *
 * The loop is loaded lazily, after the dispatcher, so the dispatcher cannot
 * import it. The loop registers a handler here while it runs; the dispatcher
 * asks it whether a refused frame was one of its `activity_update`s. A refusal
 * it claims is handled silently (the loop retries on its next poll) and never
 * reaches the generic error toast: sharing a game is passive, and a server
 * limit the user did not cause is not theirs to read about. No handler
 * registered (browser build, setting never started) claims nothing.
 *
 * The music loop (WP 8.10) has its own slot: both loops run side by side, and
 * each claims only the envelope ids of its own frames.
 */

/** Claims a refusal (`code`, envelope `id`) of one of the loop's own frames. */
export type ActivityRefusalHandler = (code: string, id: string | undefined) => boolean;

let handler: ActivityRefusalHandler | null = null;
let musicHandler: ActivityRefusalHandler | null = null;

/** Register the running loop's handler, or `null` on its teardown. */
export function setActivityRefusalHandler(next: ActivityRefusalHandler | null): void {
  handler = next;
}

/** Register the running music loop's handler, or `null` on its teardown. */
export function setMusicRefusalHandler(next: ActivityRefusalHandler | null): void {
  musicHandler = next;
}

/** Whether a running loop claimed this refusal. */
export function handleActivityRefusal(code: string, id: string | undefined): boolean {
  if (handler !== null && handler(code, id)) return true;
  return musicHandler !== null && musicHandler(code, id);
}
