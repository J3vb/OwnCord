/**
 * What the channel menu and the DM menu share about timed mutes: the duration
 * rows, in Discord's order, and the "Muted until" line. One home so the two
 * menus cannot drift (D26).
 */

import { MUTE_DURATIONS_MS } from "@lib/prefs/channelMutes";
import { formatClockTime, formatFullDate } from "@lib/text/formatting";
import { shellText } from "../i18n/shell";

const DURATION_KEYS = {
  900_000: "mute.for15m",
  3_600_000: "mute.for1h",
  10_800_000: "mute.for3h",
  28_800_000: "mute.for8h",
  86_400_000: "mute.for24h",
} as const;

/** One flyout row: a duration, or `undefined` for "until I turn it back on". */
export interface MuteChoice {
  readonly durationMs: number | undefined;
  readonly label: string;
  readonly testId: string;
}

/** The six choices, shortest first, "until turned back on" last. */
export function muteChoices(): readonly MuteChoice[] {
  const timed = MUTE_DURATIONS_MS.map((ms): MuteChoice => {
    const key = DURATION_KEYS[ms as keyof typeof DURATION_KEYS];
    return { durationMs: ms, label: shellText(key), testId: `ctx-mute-for-${ms}` };
  });
  return [
    ...timed,
    { durationMs: undefined, label: shellText("mute.untilOn"), testId: "ctx-mute-for-forever" },
  ];
}

/** `until` as a clock time, with the date when it falls on another day. */
export function clockAndDate(
  until: number,
  now = Date.now(),
): { time: string; date: string | null } {
  const at = new Date(until);
  const time = formatClockTime(at.toISOString());
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return { time, date: sameDay ? null : formatFullDate(at.toISOString()) };
}

/** "Muted until 15:30", or null for a mute that lasts until turned off. */
export function mutedUntilLabel(until: number | null): string | null {
  if (until === null) return null;
  const { time, date } = clockAndDate(until);
  return date === null
    ? shellText("mute.until", { time })
    : shellText("mute.untilDate", { date, time });
}
