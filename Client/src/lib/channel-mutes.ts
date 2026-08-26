/**
 * Per-channel notification mutes.
 *
 * A mute silences the *noise* a channel makes and nothing else. Discord's
 * semantics, which this follows exactly:
 *
 *   - no desktop notification, no chime, no taskbar flash;
 *   - the unread badge still counts, but renders dimmed — the channel has not
 *     stopped existing, it has stopped shouting;
 *   - a message that mentions you STILL notifies and still shows the red
 *     mention badge. A mute is "stop telling me about the chatter", not "hide
 *     things addressed to me", and a mute that swallowed a direct mention
 *     would be a mute nobody could safely use.
 *
 * It is a client-side preference on purpose. The server has no per-user
 * channel settings table, and "which of my devices bothers me" is a property
 * of the device, not of the account — the same reason `desktopNotifications`
 * and `notificationSounds` live in localStorage next to it.
 */

import { loadPref, savePref, STORAGE_PREFIX } from "./preferences";

/** localStorage key (under the shared settings prefix). */
const MUTED_KEY = "mutedChannels";

/**
 * Server host the mutes below belong to. The app is multi-server (saved
 * profiles keyed by host, all sharing one Tauri webview origin and therefore
 * one localStorage), and channel ids are per-server SQLite autoincrement
 * integers — without a host component in the key, muting channel 7 on one
 * server silently mutes channel 7 on every other server too. `setChannelMutesHost`
 * is always called with a real host before any mute is read (see MainPage.ts),
 * so the `null` startup default is not what protects a pre-scoping install's
 * saved mutes — `readMuted` does that below by reading through to the
 * original unscoped key on a miss at the scoped one.
 */
let currentHost: string | null = null;

function mutedKey(): string {
  return currentHost === null ? MUTED_KEY : `${MUTED_KEY}:${currentHost}`;
}

/**
 * Cached parse of the stored list. Notification gating runs on every incoming
 * message, and a JSON.parse per message for a list that changes on a menu
 * click is work nobody asked for. Invalidated by the pref-change event
 * `savePref` already dispatches, so a mute set in another part of the app (or
 * another tab, via `storage`) is picked up without a reload.
 */
let cache: ReadonlySet<number> | null = null;

/**
 * Point mute reads/writes at a specific server's key and drop the cache so
 * the next read re-parses under the new key instead of returning the
 * previous server's set. Call on connect and on server switch — mirroring
 * how `read-state.ts`'s `setMarkReadSender` and `ui.store.ts`'s
 * `loadCollapsedCategories` are wired from MainPage per-connection.
 */
export function setChannelMutesHost(host: string | null): void {
  if (host === currentHost) return;
  currentHost = host;
  invalidateMuteCache();
}

function parseMutedIds(raw: unknown): Set<number> {
  const ids = new Set<number>();
  if (Array.isArray(raw)) {
    for (const v of raw) {
      // Corrupted storage is treated as absent rather than fatal: a bad entry
      // must not cost the user their other mutes.
      if (typeof v === "number" && Number.isInteger(v) && v > 0) ids.add(v);
    }
  }
  return ids;
}

/** Whether a raw localStorage entry exists at all under `key` (prefixed) —
 *  as opposed to `loadPref`'s fallback, which can't distinguish "absent" from
 *  "present but happens to equal the fallback". An empty saved mute list is
 *  real data (the user unmuted everything) and must not be treated as a miss. */
function keyExists(key: string): boolean {
  return localStorage.getItem(STORAGE_PREFIX + key) !== null;
}

function readMuted(): ReadonlySet<number> {
  if (cache !== null) return cache;

  const scopedKey = mutedKey();
  if (currentHost === null || keyExists(scopedKey)) {
    cache = parseMutedIds(loadPref<unknown[]>(scopedKey, []));
    return cache;
  }

  // Miss at the scoped key: read through to the pre-scoping legacy key once
  // and persist the result under the scoped key so the read-through isn't
  // repeated. A different host with its OWN explicit (even empty) mute list
  // is not touched by this — it never reaches this branch.
  //
  // The legacy key is then consumed (removed) so this migration can only
  // ever apply to the FIRST host connected to post-upgrade. Channel ids are
  // per-server autoincrement integers, so leaving the legacy key in place
  // would let every subsequent brand-new host also miss its own scoped key,
  // read through to the same legacy list, and inherit server A's mutes as
  // its own (OC-0288) — every host after that falls through to `new Set()`
  // instead.
  if (keyExists(MUTED_KEY)) {
    const legacy = parseMutedIds(loadPref<unknown[]>(MUTED_KEY, []));
    writeMuted(legacy);
    localStorage.removeItem(STORAGE_PREFIX + MUTED_KEY);
    return legacy;
  }

  cache = new Set();
  return cache;
}

function writeMuted(ids: ReadonlySet<number>): void {
  cache = ids;
  savePref(mutedKey(), [...ids]);
}

/** Drop the cached parse. Exported for tests and for logout. */
export function invalidateMuteCache(): void {
  cache = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("owncord:pref-change", (e) => {
    const detail = (e as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === mutedKey()) invalidateMuteCache();
  });
  // Cross-tab: the native storage event fires only in the *other* tab.
  window.addEventListener("storage", () => invalidateMuteCache());
}

/** Whether a channel (or DM) is muted. */
export function isChannelMuted(channelId: number): boolean {
  return readMuted().has(channelId);
}

/** Every muted channel id, ascending — a stable order for the settings list. */
export function listMutedChannels(): readonly number[] {
  return [...readMuted()].toSorted((a, b) => a - b);
}

/** Mute a channel. Idempotent. */
export function muteChannel(channelId: number): void {
  const next = new Set(readMuted());
  next.add(channelId);
  writeMuted(next);
}

/** Unmute a channel. Idempotent. */
export function unmuteChannel(channelId: number): void {
  const next = new Set(readMuted());
  next.delete(channelId);
  writeMuted(next);
}

/** Flip a channel's mute and report the new state. */
export function toggleChannelMute(channelId: number): boolean {
  if (isChannelMuted(channelId)) {
    unmuteChannel(channelId);
    return false;
  }
  muteChannel(channelId);
  return true;
}

/**
 * Whether an incoming message in `channelId` may raise a notification, given
 * whether it mentions the reader.
 *
 * This is the whole mute rule in one place, so the desktop popup, the chime
 * and the taskbar flash cannot end up applying three slightly different
 * versions of it.
 */
export function notificationAllowed(channelId: number, mentioned: boolean): boolean {
  return mentioned || !isChannelMuted(channelId);
}
