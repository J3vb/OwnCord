/**
 * The "Playing <game>" wording, shared by the member row, the DM row and the
 * profile cards. Pure: the caller passes the clock.
 */

import { gameActivityText as t } from "../../i18n/gameActivity";

/** A game as a surface needs it: its name and when it started (unix ms). */
export interface PlayingActivity {
  readonly name: string;
  readonly startedAt: number;
}

/** The row line: "Playing VALORANT". */
export function playingLine(activity: PlayingActivity): string {
  return t("playing", { game: activity.name });
}

/**
 * The profile line: "Playing VALORANT · for 23 min". Under a minute (or a
 * start time in the future, from a skewed clock) it says "just started".
 */
export function playingForLine(activity: PlayingActivity, nowMs: number): string {
  const minutes = Math.floor((nowMs - activity.startedAt) / 60_000);
  const game = activity.name;
  if (!Number.isFinite(minutes) || minutes < 1) return t("playing.justStarted", { game });
  if (minutes < 60) return t("playing.minutes", { game, count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? t("playing.hours", { game, hours })
    : t("playing.hoursMinutes", { game, hours, minutes: rest });
}
