/**
 * The device-local choices about games: programs added by hand, games
 * hidden from others, names changed for display, and the games this device has
 * detected. Stored like the sharing switch (`owncord:settings:*` in
 * `localStorage`); the server never learns any of it, only the one shown name.
 *
 * Stored data may be malformed or from another version, so every read goes
 * through `parseGamePrefs` / `parseSeen`, which keep what is valid field by
 * field and never throw. Names are 1-128 characters after trimming (what the
 * server accepts).
 *
 * The user's choices (`manual`, `hidden`, `renames`) and the detection history
 * (`seen`, written by the poll loop) are two keys, so the loop recording a game
 * does not look like the user changing a choice.
 */

import { loadPref, savePref } from "./preferences";
import type { DetectPrefs } from "../../platform/contracts/gameDetector";

/** The pref holding `{ manual, hidden, renames }`. */
export const GAME_PREFS_KEY = "gameActivityGames";
/** The pref holding the detected names, newest first. */
export const GAME_SEEN_KEY = "gameActivitySeen";

export const MAX_GAME_NAME_CHARS = 128;
/** Detected names kept. */
export const MAX_SEEN = 50;
const MAX_MANUAL = 100;
const MAX_HIDDEN = 500;
const MAX_RENAMES = 500;
const MAX_PATH_CHARS = 4096;

export interface ManualGameEntry {
  readonly path: string;
  readonly name: string;
}

export interface GamePrefs {
  readonly manual: readonly ManualGameEntry[];
  /** Detected names not shown to others. */
  readonly hidden: readonly string[];
  /** Detected name -> the name shown instead. */
  readonly renames: Readonly<Record<string, string>>;
}

export const EMPTY_GAME_PREFS: GamePrefs = { manual: [], hidden: [], renames: {} };

/** A game name as stored and sent: trimmed, 1-128 characters, else null. */
export function cleanGameName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "" || Array.from(name).length > MAX_GAME_NAME_CHARS) return null;
  return name;
}

/** The comparison key for a name: names match without regard to case. */
export function gameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The comparison key for a program path. It mirrors `normalize_path` in
 * `src-tauri/src/game_activity.rs` step by step (quotes trimmed, lower-cased,
 * `\` to `/`, a ` (deleted)` suffix, a `\\?\` prefix and a leading drive
 * letter dropped), so the page and the scanner agree on what is one program.
 * The drive letter is ignored on purpose: a Proton game's `Z:\home\u\...`
 * must match the Linux path it points at.
 */
export function pathKey(raw: string): string {
  const lower = raw
    .trim()
    .replace(/^"+|"+$/g, "")
    .toLowerCase()
    .replace(/\\/g, "/");
  const noSuffix = lower.endsWith(" (deleted)") ? lower.slice(0, -" (deleted)".length) : lower;
  const noPrefix = noSuffix.startsWith("//?/") ? noSuffix.slice(4) : noSuffix;
  return /^[a-z]:/.test(noPrefix) ? noPrefix.slice(2) : noPrefix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The prefs a stored value holds; anything invalid is dropped, never thrown. */
export function parseGamePrefs(raw: unknown): GamePrefs {
  if (!isRecord(raw)) return EMPTY_GAME_PREFS;

  const manual: ManualGameEntry[] = [];
  const paths = new Set<string>();
  if (Array.isArray(raw.manual)) {
    for (const item of raw.manual as unknown[]) {
      if (manual.length >= MAX_MANUAL) break;
      if (!isRecord(item) || typeof item.path !== "string") continue;
      const path = item.path.trim();
      const name = cleanGameName(item.name);
      if (path === "" || path.length > MAX_PATH_CHARS || name === null) continue;
      if (paths.has(pathKey(path))) continue;
      paths.add(pathKey(path));
      manual.push({ path, name });
    }
  }

  const hidden: string[] = [];
  const hiddenKeys = new Set<string>();
  if (Array.isArray(raw.hidden)) {
    for (const item of raw.hidden as unknown[]) {
      if (hidden.length >= MAX_HIDDEN) break;
      const name = cleanGameName(item);
      if (name === null || hiddenKeys.has(gameKey(name))) continue;
      hiddenKeys.add(gameKey(name));
      hidden.push(name);
    }
  }

  const renames: Record<string, string> = {};
  if (isRecord(raw.renames)) {
    for (const [from, to] of Object.entries(raw.renames)) {
      if (Object.keys(renames).length >= MAX_RENAMES) break;
      const source = cleanGameName(from);
      const shown = cleanGameName(to);
      if (source !== null && shown !== null) renames[source] = shown;
    }
  }
  return { manual, hidden, renames };
}

/** The detected names a stored value holds: valid, distinct, at most 50. */
export function parseSeen(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const keys = new Set<string>();
  for (const item of raw as unknown[]) {
    if (out.length >= MAX_SEEN) break;
    const name = cleanGameName(item);
    if (name === null || keys.has(gameKey(name))) continue;
    keys.add(gameKey(name));
    out.push(name);
  }
  return out;
}

export function loadGamePrefs(): GamePrefs {
  return parseGamePrefs(loadPref<unknown>(GAME_PREFS_KEY, {}));
}

export function saveGamePrefs(prefs: GamePrefs): void {
  savePref(GAME_PREFS_KEY, prefs);
}

export function loadSeen(): string[] {
  return parseSeen(loadPref<unknown>(GAME_SEEN_KEY, []));
}

/** Put a detected name first in the history (once, newest first, capped).
 *  Saves only when the history changes, so a steady game costs no writes. */
export function recordSeen(name: string): void {
  const clean = cleanGameName(name);
  if (clean === null) return;
  const seen = loadSeen();
  if (seen[0] !== undefined && gameKey(seen[0]) === gameKey(clean)) return;
  const next = [clean, ...seen.filter((s) => gameKey(s) !== gameKey(clean))].slice(0, MAX_SEEN);
  savePref(GAME_SEEN_KEY, next);
}

/** What the scanner is told. */
export function toDetectPrefs(prefs: GamePrefs): DetectPrefs {
  return { manual: prefs.manual, hidden: prefs.hidden };
}

export function isHidden(prefs: GamePrefs, name: string): boolean {
  const key = gameKey(name);
  return prefs.hidden.some((h) => gameKey(h) === key);
}

/** The name to show others for a detected one: its rename, else itself. */
export function displayName(prefs: GamePrefs, detected: string): string {
  const key = gameKey(detected);
  for (const [from, to] of Object.entries(prefs.renames)) {
    if (gameKey(from) === key) return to;
  }
  return detected;
}

// -- changes, each returning the new prefs (the caller saves) ----------------------

export function withHidden(prefs: GamePrefs, name: string, hide: boolean): GamePrefs {
  const key = gameKey(name);
  const rest = prefs.hidden.filter((h) => gameKey(h) !== key);
  return { ...prefs, hidden: hide ? [...rest, name.trim()] : rest };
}

/** Rename a detected game; a blank or unchanged name resets it. */
export function withRename(prefs: GamePrefs, detected: string, shown: string): GamePrefs {
  const key = gameKey(detected);
  const renames: Record<string, string> = {};
  for (const [from, to] of Object.entries(prefs.renames)) {
    if (gameKey(from) !== key) renames[from] = to;
  }
  const clean = cleanGameName(shown);
  if (clean !== null && clean !== detected.trim()) renames[detected.trim()] = clean;
  return { ...prefs, renames };
}

/** Add (or replace, by path) a manual entry. Null when path or name is invalid. */
export function withManual(prefs: GamePrefs, path: string, name: string): GamePrefs | null {
  const cleanName = cleanGameName(name);
  const cleanPath = path.trim();
  if (cleanName === null || cleanPath === "" || cleanPath.length > MAX_PATH_CHARS) return null;
  const key = pathKey(cleanPath);
  const rest = prefs.manual.filter((m) => pathKey(m.path) !== key);
  if (rest.length >= MAX_MANUAL) return null;
  return { ...prefs, manual: [...rest, { path: cleanPath, name: cleanName }] };
}

/** Remove a manual entry, with the rename and hide that belonged to its name
 *  unless another entry or a detected game (`seen`) still carries that name. */
export function withoutManual(prefs: GamePrefs, path: string, seen: readonly string[]): GamePrefs {
  const key = pathKey(path);
  const removed = prefs.manual.find((m) => pathKey(m.path) === key);
  const manual = prefs.manual.filter((m) => pathKey(m.path) !== key);
  if (removed === undefined) return prefs;
  const nameKey = gameKey(removed.name);
  const shared =
    manual.some((m) => gameKey(m.name) === nameKey) || seen.some((n) => gameKey(n) === nameKey);
  const next: GamePrefs = { ...prefs, manual };
  return shared ? next : withHidden(withRename(next, removed.name, ""), removed.name, false);
}
