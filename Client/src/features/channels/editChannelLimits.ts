/** The slow-mode and voice-limit ceilings the edit dialog mirrors from the server, and their clamps. */

import { shellText } from "../../i18n/shell";

/** The server's ceiling for `slow_mode`, mirrored so the UI cannot exceed it. */
export const MAX_SLOW_MODE_SECONDS = 21600;
/** The server's ceiling for both voice capacity limits. */
export const MAX_VOICE_LIMIT = 99;

/** Slow-mode presets, in seconds. 0 = off. */
export const SLOW_MODE_PRESETS: readonly number[] = [
  0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600,
];

/** Human label for a slow-mode second count, preset or not. */
export function formatSlowMode(seconds: number): string {
  if (seconds === 0) return shellText("slowMode.off");
  if (seconds % 3600 === 0) return shellText("slowMode.hours", { count: seconds / 3600 });
  if (seconds % 60 === 0) return shellText("slowMode.minutes", { count: seconds / 60 });
  return shellText("slowMode.seconds", { count: seconds });
}

/**
 * Clamp a value into the server's accepted slow-mode range.
 * Applied to the STORED value as well as the submitted one, so a row carrying
 * something out of range still opens the modal on a legal option.
 */
export function clampSlowMode(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SLOW_MODE_SECONDS, Math.max(0, Math.trunc(value)));
}

/**
 * Clamp a voice limit into the server's accepted range.
 *
 * A `<input type="number" max>` is advisory — typing past it, or pasting, still
 * produces the larger value — so the bound is applied here rather than trusting
 * the attribute and letting the server 400 a form the user had no way to fix.
 */
export function clampVoiceLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_VOICE_LIMIT, Math.max(0, Math.trunc(value)));
}
