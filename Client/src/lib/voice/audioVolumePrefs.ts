// Per-user and output volume prefs for remote voice, plus the pure
// volume helpers the audio elements use. Split from audioElements.ts.

import { loadPref, STORAGE_PREFIX } from "@lib/prefs/preferences";
import { migrateLegacyValue } from "@lib/net/legacyKeyMigration";
import { USER_LOCAL_MUTE_CHANGED } from "@lib/constants";

/**
 * Server host the per-user volume prefs below belong to. Mirrors
 * channel-mutes.ts's currentHost — the client is multi-server (one webview
 * origin means one localStorage) and userId is only unique per server, so
 * without a host component a volume set for user 7 on one server would
 * silence user 7 on every other server too. `setAudioVolumeHost` is always
 * called with a real host before any volume is read (see MainPage.ts), so
 * the `null` startup default is not what protects a pre-scoping install's
 * saved volumes — `getSavedUserVolume` does that below by reading through to
 * the original unscoped key on a miss at the scoped one.
 */
let currentHost: string | null = null;

/** Point per-user volume reads/writes at a specific server. Call on connect
 *  and on server switch — mirroring channel-mutes.ts's setChannelMutesHost. */
export function setAudioVolumeHost(host: string | null): void {
  currentHost = host;
}

export function userVolumeKey(userId: number): string {
  // i18n-exempt: localStorage key, not display text
  return currentHost === null ? `userVolume_${userId}` : `userVolume_${userId}:${currentHost}`;
}

export function userLocalMuteKey(userId: number): string {
  const key = `userLocalMute_${userId}`;
  // i18n-exempt: localStorage key, not display text
  return currentHost === null ? key : `${key}:${currentHost}`;
}

export function announceLocalMute(userId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(USER_LOCAL_MUTE_CHANGED, { detail: { userId } }));
}

// setUserVolume always clamps to 0-200, so -1 is safe as a "nothing saved" sentinel.
const VOLUME_NOT_SET = -1;

/** Per-user and output volume sliders go to 200%. Above 100% a voice track
 *  needs its gain node: LiveKit's web setVolume writes HTMLMediaElement.volume,
 *  which throws above 1 and failed voice joins. */
export const MAX_VOLUME_PERCENT = 200;

/** Per-user volume times output volume never plays louder than double. */
export const MAX_GAIN = 2;

/** Clamp a stored or requested percentage into 0-200 (NaN reads as 100). */
export function clampPercent(v: number): number {
  return Number.isNaN(v) ? 100 : Math.max(0, Math.min(MAX_VOLUME_PERCENT, v));
}

/** Get saved per-user volume (0-200 range, default 100; a larger value reads
 *  as 200). On a miss at the host-scoped key, migrates
 *  the pre-scoping unscoped value through `migrateLegacyValue`, which moves
 *  it under the scoped key of the FIRST host that misses and no other. User
 *  ids are per-server autoincrement integers: a legacy value left readable
 *  would let every later brand-new host miss its own scoped key, read
 *  through to it and silence the unrelated user N there too — the
 *  shape channel-mutes.ts fixed for the same leak. */
export function getSavedUserVolume(userId: number): number {
  return clampPercent(readSavedUserVolume(userId));
}

function readSavedUserVolume(userId: number): number {
  const scopedKey = userVolumeKey(userId);
  if (currentHost === null) return loadPref<number>(scopedKey, 100);

  const scoped = loadPref<number>(scopedKey, VOLUME_NOT_SET);
  if (scoped !== VOLUME_NOT_SET) return scoped;

  const legacy = migrateLegacyValue(
    `${STORAGE_PREFIX}userVolume_${userId}`,
    STORAGE_PREFIX + scopedKey,
  );
  if (legacy !== null) {
    const parsed = parseStoredVolume(legacy);
    if (parsed !== null) return parsed;
  }
  return loadPref<number>(scopedKey, 100);
}

/** The stored form is loadPref's JSON; anything but a number is corrupt. */
function parseStoredVolume(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "number" ? parsed : null;
  } catch {
    return null;
  }
}
