/**
 * The game running on this machine (WP 8.3), for the "Playing <game>" status.
 * The host scans its own process list and hands back only the one name; the
 * list never reaches the page (`src-tauri/src/game_activity.rs`).
 */

/** Which source named the game: an installed library or the built-in list. */
export type DetectedGameSource = "steam" | "epic" | "list";

export interface DetectedGame {
  readonly name: string;
  readonly source: DetectedGameSource;
  /** Unix milliseconds the game's process started. */
  readonly startedAtMs: number;
}

export interface GameDetector {
  /** False where nothing can be scanned (the web build): the setting is hidden
   *  and no poll runs. Others' games are still shown there. */
  readonly available: boolean;
  /** The game being played, or null. Never rejects: a host failure reads as
   *  "no game". */
  detect(): Promise<DetectedGame | null>;
}
