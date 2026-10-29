/**
 * The screen share frame rates offered beside the default (each quality's own
 * rate). 120 is hidden for now: WebView2's screen capture delivers about
 * 60 fps whatever is asked, so a 120 fps share only cost bitrate. Its handling
 * stays in place (the picker's monitor gate, the 120 fps degradation and
 * bitrate rules) for when a capture path that reaches 120 exists.
 */

/** Whether 120 fps is offered. */
export const SCREEN_SHARE_120_FPS = false;

/** The explicit rates the settings and the share picker list. */
export const SHARE_FPS_OPTIONS: readonly number[] = SCREEN_SHARE_120_FPS ? [60, 120] : [60];

/** A saved rate as the app uses it: 60 or 120 when offered, a saved 120 reads
 *  as 60 while 120 is hidden, anything else is 30 (the default). */
export function offeredShareFps(saved: number): number {
  if (saved === 120 && !SCREEN_SHARE_120_FPS) return 60;
  return SHARE_FPS_OPTIONS.includes(saved) ? saved : 30;
}
