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

import { loadPref, savePref } from "./preferences";

/** localStorage key (under the shared settings prefix). */
const MUTED_KEY = "mutedChannels";

/**
 * Cached parse of the stored list. Notification gating runs on every incoming
 * message, and a JSON.parse per message for a list that changes on a menu
 * click is work nobody asked for. Invalidated by the pref-change event
 * `savePref` already dispatches, so a mute set in another part of the app (or
 * another tab, via `storage`) is picked up without a reload.
 */
let cache: ReadonlySet<number> | null = null;

function readMuted(): ReadonlySet<number> {
  if (cache !== null) return cache;
  const raw = loadPref<unknown[]>(MUTED_KEY, []);
  const ids = new Set<number>();
  if (Array.isArray(raw)) {
    for (const v of raw) {
      // Corrupted storage is treated as absent rather than fatal: a bad entry
      // must not cost the user their other mutes.
      if (typeof v === "number" && Number.isInteger(v) && v > 0) ids.add(v);
    }
  }
  cache = ids;
  return ids;
}

function writeMuted(ids: ReadonlySet<number>): void {
  cache = ids;
  savePref(MUTED_KEY, [...ids]);
}

/** Drop the cached parse. Exported for tests and for logout. */
export function invalidateMuteCache(): void {
  cache = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("owncord:pref-change", (e) => {
    const detail = (e as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === MUTED_KEY) invalidateMuteCache();
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
