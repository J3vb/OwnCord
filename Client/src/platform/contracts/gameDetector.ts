/**
 * The game running on this machine, for the "Playing <game>" status.
 * The host scans its own process list and hands back only the one name; the
 * list never reaches the page (`src-tauri/src/game_activity.rs`).
 */

/** Which source named the game: an installed library, the built-in list or a
 *  program the user added by hand. */
export type DetectedGameSource =
  "steam" | "epic" | "gog" | "battlenet" | "lutris" | "list" | "manual";

export interface DetectedGame {
  readonly name: string;
  readonly source: DetectedGameSource;
  /** Unix milliseconds the game's process started. */
  readonly startedAtMs: number;
}

/** A program the user added as a game: its executable and the name to show. */
export interface ManualGame {
  readonly path: string;
  readonly name: string;
}

/** What the user decided about games, handed to every scan. */
export interface DetectPrefs {
  readonly manual: readonly ManualGame[];
  /** Detected game names that are not shown to others (case-insensitive). */
  readonly hidden: readonly string[];
}

/** One running program offered in the "Add a game" picker. */
export interface RunningProgram {
  /** The executable's file name without its extension. */
  readonly name: string;
  readonly path: string;
}

export interface GameDetector {
  /** False where nothing can be scanned (the web build): the setting is hidden
   *  and no poll runs. Others' games are still shown there. */
  readonly available: boolean;
  /** The game being played, or null. A manual entry wins over an automatic
   *  match and a hidden game is skipped. Never rejects: a host failure reads
   *  as "no game". */
  detect(prefs?: DetectPrefs): Promise<DetectedGame | null>;
  /** The user's own running programs, for the picker. The list stays on this
   *  device; it is only shown locally. Never rejects: a failure reads as []. */
  listRunningPrograms(): Promise<readonly RunningProgram[]>;
}
