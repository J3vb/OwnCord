/**
 * The device-local choices about music: the players hidden from
 * others and the players this device has seen. Stored like the sharing switch
 * (`owncord:settings:*` in `localStorage`); the server never learns any of it,
 * only the one shown song. Not part of support bundles.
 *
 * Stored data may be malformed or from another version, so every read goes
 * through `parseMusicPrefs` / `parseSeenPlayers`, which keep what is valid
 * field by field and never throw.
 *
 * The user's choice (`hidden`) and the detection history (`seen`, written by
 * the poll loop) are two keys, so the loop recording a player does not look
 * like the user changing a choice.
 */

import { loadPref, savePref } from "./preferences";
import type { MediaPrefs } from "../../platform/contracts/mediaDetector";

/** The device-local setting "Share the music you're listening to". */
export const MUSIC_ACTIVITY_PREF_KEY = "shareMusicActivity";

/** Whether this device shares the song being listened to. On unless turned off. */
export function isMusicActivityShared(): boolean {
  return loadPref<boolean>(MUSIC_ACTIVITY_PREF_KEY, true);
}

/** The pref holding `{ hidden }`. */
export const MUSIC_PREFS_KEY = "musicActivityPlayers";
/** The pref holding the players seen, newest first. */
export const MUSIC_SEEN_KEY = "musicActivitySeen";

/** Players kept in the history. */
export const MAX_SEEN_PLAYERS = 50;
const MAX_HIDDEN = 200;
const MAX_ID_CHARS = 256;
/** The longest player name the server accepts, in characters. */
export const MAX_PLAYER_NAME_CHARS = 64;

export interface MusicPrefs {
  /** Player ids (the host's `playerId`) not shown to others. */
  readonly hidden: readonly string[];
}

/** A player this device has seen playing. */
export interface SeenPlayer {
  readonly id: string;
  /** The display name ("Spotify"). */
  readonly name: string;
}

export const EMPTY_MUSIC_PREFS: MusicPrefs = { hidden: [] };

/** A player id as stored: trimmed, 1-256 characters, else null. */
export function cleanPlayerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id === "" || id.length > MAX_ID_CHARS ? null : id;
}

/** A player name as stored: trimmed, 1-64 characters, else null. */
export function cleanPlayerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "" || Array.from(name).length > MAX_PLAYER_NAME_CHARS) return null;
  return name;
}

/** The comparison key for an id: ids match without regard to case. */
export function playerKey(id: string): string {
  return id.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The prefs a stored value holds; anything invalid is dropped, never thrown. */
export function parseMusicPrefs(raw: unknown): MusicPrefs {
  if (!isRecord(raw) || !Array.isArray(raw["hidden"])) return EMPTY_MUSIC_PREFS;
  const hidden: string[] = [];
  const keys = new Set<string>();
  for (const item of raw["hidden"] as unknown[]) {
    if (hidden.length >= MAX_HIDDEN) break;
    const id = cleanPlayerId(item);
    if (id === null || keys.has(playerKey(id))) continue;
    keys.add(playerKey(id));
    hidden.push(id);
  }
  return { hidden };
}

/** The players a stored value holds: valid, distinct by id, at most 50. */
export function parseSeenPlayers(raw: unknown): SeenPlayer[] {
  if (!Array.isArray(raw)) return [];
  const out: SeenPlayer[] = [];
  const keys = new Set<string>();
  for (const item of raw as unknown[]) {
    if (out.length >= MAX_SEEN_PLAYERS) break;
    if (!isRecord(item)) continue;
    const id = cleanPlayerId(item["id"]);
    const name = cleanPlayerName(item["name"]);
    if (id === null || name === null || keys.has(playerKey(id))) continue;
    keys.add(playerKey(id));
    out.push({ id, name });
  }
  return out;
}

export function loadMusicPrefs(): MusicPrefs {
  return parseMusicPrefs(loadPref<unknown>(MUSIC_PREFS_KEY, {}));
}

export function saveMusicPrefs(prefs: MusicPrefs): void {
  savePref(MUSIC_PREFS_KEY, prefs);
}

export function loadSeenPlayers(): SeenPlayer[] {
  return parseSeenPlayers(loadPref<unknown>(MUSIC_SEEN_KEY, []));
}

/** Put a seen player first in the history (once, newest first, capped). Saves
 *  only when the history changes, so a steady player costs no writes. */
export function recordSeenPlayer(id: string, name: string): void {
  const cleanId = cleanPlayerId(id);
  const cleanName = cleanPlayerName(name);
  if (cleanId === null || cleanName === null) return;
  const seen = loadSeenPlayers();
  const first = seen[0];
  if (
    first !== undefined &&
    playerKey(first.id) === playerKey(cleanId) &&
    first.name === cleanName
  ) {
    return;
  }
  const rest = seen.filter((p) => playerKey(p.id) !== playerKey(cleanId));
  savePref(MUSIC_SEEN_KEY, [{ id: cleanId, name: cleanName }, ...rest].slice(0, MAX_SEEN_PLAYERS));
}

/** What the host is told with every poll. */
export function toMediaPrefs(prefs: MusicPrefs): MediaPrefs {
  return { hidden: prefs.hidden };
}

export function isPlayerHidden(prefs: MusicPrefs, id: string): boolean {
  const key = playerKey(id);
  return prefs.hidden.some((h) => playerKey(h) === key);
}

/** Hide or show a player; returns the new prefs (the caller saves). */
export function withPlayerHidden(prefs: MusicPrefs, id: string, hide: boolean): MusicPrefs {
  const key = playerKey(id);
  const rest = prefs.hidden.filter((h) => playerKey(h) !== key);
  return { hidden: hide ? [...rest, id.trim()] : rest };
}
