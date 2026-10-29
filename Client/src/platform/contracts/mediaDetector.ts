/**
 * The song playing on this machine (WP 8.10), for the "Listening to <player>"
 * status. The host asks the OS media session (Windows GSMTC, Linux MPRIS) and
 * hands back only the one song (`src-tauri/src/media_activity.rs`).
 */

/** The song a player is playing right now. */
export interface DetectedMedia {
  readonly title: string;
  /** May be empty. */
  readonly artist: string;
  /** The player's display name ("Spotify"). */
  readonly player: string;
  /** A stable id for the hide list. */
  readonly playerId: string;
  /** How far into the song, in milliseconds. */
  readonly positionMs: number;
  /** The song's length in milliseconds; 0 when the player does not say. */
  readonly durationMs: number;
}

/**
 * One poll's answer. `unknown` means the read failed or an earlier read is
 * still running: the caller keeps what it showed rather than mistaking a stall
 * for a stop.
 */
export type MediaReading =
  | ({ readonly state: "playing" } & DetectedMedia)
  | { readonly state: "none" }
  | { readonly state: "unknown" };

/** What the user decided about players, handed to every poll. */
export interface MediaPrefs {
  /** Player ids (`playerId` of an earlier answer) that are not shown to others. */
  readonly hidden: readonly string[];
}

export interface MediaDetector {
  /** False where nothing can be read (the web build): the setting is hidden
   *  and no poll runs. Others' songs are still shown there. */
  readonly available: boolean;
  /** The song being played. Never rejects: a host failure reads as `unknown`. */
  detect(prefs: MediaPrefs): Promise<MediaReading>;
}
