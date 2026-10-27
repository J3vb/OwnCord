/**
 * The "Listening to <player>" wording for a song (WP 8.10), shared by the
 * member row, the DM row and the profile cards. Pure. The profile card itself
 * (`listeningCard.ts`) is separate: only the lazy popup and sidebar load it.
 */

import { listeningActivityText as t } from "../../i18n/listeningActivity";
import type { IconName } from "../../lib/icons";
import { playingLine, type PlayingActivity } from "./gameActivityLine";

/** A song as a surface needs it. */
export interface ListeningSong {
  readonly title: string;
  /** May be empty. */
  readonly artist: string;
  readonly player: string;
  /** Unix milliseconds the song would have started at. */
  readonly startedAt: number;
  /** 0 = unknown. */
  readonly durationMs: number;
}

/** What the second line of a row shows, and which icon goes with it. */
export interface RowActivity {
  readonly text: string;
  readonly icon: IconName;
}

/** The row line: "Listening to Spotify". */
export function listeningLine(song: Pick<ListeningSong, "player">): string {
  return t("listening", { player: song.player });
}

/**
 * The row's second line when there is no custom status: a game beats music
 * (Discord does the same). Null when there is neither.
 */
export function rowActivity(
  game: PlayingActivity | null | undefined,
  song: ListeningSong | null | undefined,
): RowActivity | null {
  if (game != null) return { text: playingLine(game), icon: "gamepad-2" };
  if (song != null) return { text: listeningLine(song), icon: "music" };
  return null;
}
