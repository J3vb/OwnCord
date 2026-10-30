/**
 * Per-channel notification mutes.
 *
 * A mute silences the *noise* a channel makes and nothing else. Discord's
 * semantics, which this follows exactly:
 *
 *   - no desktop notification, no chime, no taskbar flash;
 *   - plain unread shows no bold name and no pill — the channel has not
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

import {
  loadPref,
  onPrefChange,
  readStored,
  removeStored,
  savePref,
  STORAGE_PREFIX,
} from "./preferences";
import { registerSessionReset } from "../sessionRegistry";

/**
 * The timed-mute choices, shortest first. "Until I turn it back on" is the
 * absence of a duration (`undefined`), never a number in this list.
 */
export const MUTE_DURATIONS_MS: readonly number[] = [
  900_000, 3_600_000, 10_800_000, 28_800_000, 86_400_000,
];

/** localStorage key (under the shared settings prefix). */
const MUTED_KEY = "mutedChannels";

/**
 * Window event fired after any mute change. Dispatched from the store rather
 * than a single caller, so every writer (the channel context menu, the
 * Settings unmute list, a global shortcut) reaches the sidebars that redraw
 * on it — the Settings unmute used to leave a sidebar row dimmed (F16).
 */
export const CHANNEL_MUTE_CHANGED = "owncord:channel-mute-changed";

export function announceMuteChange(channelId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANNEL_MUTE_CHANGED, { detail: { channelId } }));
}

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
let cache: ReadonlyMap<number, number | null> | null = null;

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

// The scope is set by MainPage on mount; a session that ends leaves no server's
// scope behind (the connect page's Settings would offer its override, F13).
void registerSessionReset("channel-mutes:host", () => setChannelMutesHost(null), {
  phase: "cache",
}); // app-lifetime

/** The host the per-server prefs are currently scoped to. Other per-server
 *  client prefs (the notification level override) read it through this getter
 *  rather than carrying their own copy and a second MainPage setter. */
export function getChannelMutesHost(): string | null {
  return currentHost;
}

function validId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Parse the stored list. An element is a bare id (muted until turned off, the
 * original format) or `{ id, until }` (a timed mute, `until` in epoch ms). The
 * map value is `null` for "until turned off". A later duplicate wins.
 */
function parseMuted(raw: unknown): Map<number, number | null> {
  const entries = new Map<number, number | null>();
  if (Array.isArray(raw)) {
    for (const v of raw) {
      // Corrupted storage is treated as absent rather than fatal: a bad entry
      // must not cost the user their other mutes.
      if (validId(v)) {
        entries.set(v, null);
      } else if (typeof v === "object" && v !== null) {
        const { id, until } = v as { id?: unknown; until?: unknown };
        if (validId(id) && typeof until === "number" && Number.isFinite(until) && until > 0) {
          entries.set(id, until);
        }
      }
    }
  }
  return entries;
}

/** Whether a raw localStorage entry exists at all under `key` (prefixed) —
 *  as opposed to `loadPref`'s fallback, which can't distinguish "absent" from
 *  "present but happens to equal the fallback". An empty saved mute list is
 *  real data (the user unmuted everything) and must not be treated as a miss. */
function keyExists(key: string): boolean {
  return readStored(STORAGE_PREFIX + key) !== null;
}

/** The stored entries (`null` = until turned off), expired ones included.
 *  For the expiry module, which prunes them; callers ask `isChannelMuted`. */
export function readMutedEntries(): ReadonlyMap<number, number | null> {
  return readMuted();
}

function readMuted(): ReadonlyMap<number, number | null> {
  if (cache !== null) return cache;

  const scopedKey = mutedKey();
  if (currentHost === null || keyExists(scopedKey)) {
    cache = parseMuted(loadPref<unknown[]>(scopedKey, []));
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
  // its own — every host after that falls through to `new Set()`
  // instead.
  if (keyExists(MUTED_KEY)) {
    const legacy = parseMuted(loadPref<unknown[]>(MUTED_KEY, []));
    writeMuted(legacy);
    removeStored(STORAGE_PREFIX + MUTED_KEY);
    return legacy;
  }

  cache = new Map();
  return cache;
}

/** Write the list, dropping entries that have already expired. A forever mute
 *  is written as a bare id, so a list without timed mutes is byte-identical
 *  to the original format. */
function writeMuted(entries: ReadonlyMap<number, number | null>, now = Date.now()): void {
  // Dropped expired entries are not announced one by one here; the writers that
  // matter announce, and listeners redraw everything from the store.
  const live = new Map<number, number | null>();
  const out: Array<number | { id: number; until: number }> = [];
  for (const [id, until] of entries) {
    if (until !== null && until <= now) continue;
    live.set(id, until);
    out.push(until === null ? id : { id, until });
  }
  cache = live;
  savePref(mutedKey(), out);
}

/** Replace the stored list (expired entries are dropped). For the expiry module. */
export function replaceMutedEntries(
  entries: ReadonlyMap<number, number | null>,
  now: number,
): void {
  writeMuted(entries, now);
}

/** Whether an entry still mutes at `now`. */
function active(until: number | null | undefined, now: number): boolean {
  return until === null || (until !== undefined && now < until);
}

/** Drop the cached parse. Exported for tests and for logout. */
export function invalidateMuteCache(): void {
  cache = null;
}

if (typeof window !== "undefined") {
  onPrefChange("any", (key) => {
    if (key === mutedKey()) invalidateMuteCache();
  });
  // Cross-tab: the native storage event fires only in the *other* tab.
  window.addEventListener("storage", () => invalidateMuteCache());
}

/**
 * Whether a channel (or DM) is muted. Expiry is decided here, at read time, so
 * the notify gates and the badge are right even if no timer ever fired.
 */
export function isChannelMuted(channelId: number): boolean {
  return active(readMuted().get(channelId), Date.now());
}

/** A channel's active mute, for labels: `until` is null for "until turned off". */
export function getChannelMute(channelId: number): { until: number | null } | null {
  const until = readMuted().get(channelId);
  return active(until, Date.now()) && until !== undefined ? { until } : null;
}

/** Every actively muted channel id, ascending — a stable order for the settings list. */
export function listMutedChannels(): readonly number[] {
  const now = Date.now();
  return [...readMuted()]
    .filter(([, until]) => active(until, now))
    .map(([id]) => id)
    .toSorted((a, b) => a - b);
}

/**
 * Mute a channel, replacing any existing mute so the latest choice wins.
 * Without `durationMs` the mute lasts until turned off. A duration that is not
 * one of `MUTE_DURATIONS_MS` is refused (returns false, nothing changes).
 */
export function muteChannel(channelId: number, durationMs?: number): boolean {
  if (durationMs !== undefined && !MUTE_DURATIONS_MS.includes(durationMs)) return false;
  const next = new Map(readMuted());
  next.set(channelId, durationMs === undefined ? null : Date.now() + durationMs);
  writeMuted(next);
  announceMuteChange(channelId);
  return true;
}

/** Unmute a channel. Idempotent. */
export function unmuteChannel(channelId: number): void {
  const next = new Map(readMuted());
  next.delete(channelId);
  writeMuted(next);
  announceMuteChange(channelId);
}

/** Flip a channel's mute (until turned off) and report the new state. */
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
