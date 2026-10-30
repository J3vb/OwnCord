/**
 * Notification level — how much a server is allowed to interrupt you:
 *
 *   - `all`      every message in a channel you are not looking at;
 *   - `mentions` only messages that name you, plus direct messages;
 *   - `nothing`  no popup, no chime, no taskbar flash for the server's
 *                channels. A direct message is never silenced by the level:
 *                it is a person writing to you, not server chatter (Discord
 *                does the same).
 *
 * The default is `mentions` (owner question Q8: "Mentions-only for new
 * installs"), because "every message pings you" is the pain this level exists
 * to answer — an install that has never been configured should not start loud.
 * An install from before the level keeps All (settleNotificationLevelDefault).
 *
 * The level is a device preference, not an account one, for the same reason
 * `channel-mutes.ts`, `desktopNotifications` and `notificationSounds` are: the
 * server has no per-user settings table, and "how much this machine may
 * interrupt me" is a property of the machine. A per-server override is keyed
 * by host (ids are only unique per server, and one webview origin shares one
 * localStorage) and an absent override falls through to the global level.
 *
 * A channel can carry its own level (`channelNotificationLevels:<host>`), which
 * beats the server level in both directions. It is read uncached on purpose:
 * there is no cross-window invalidation to get wrong, and the read is one small
 * JSON parse (the badge reads it once per count via `channelLevelResolver`).
 *
 * This module only decides *whether* a level permits a notification; the
 * per-channel mute (`channel-mutes.ts`) and the focused-window check stay
 * where they are. A level of `nothing` is the one case that also silences a
 * channel mention — the mute rule deliberately never does — so the level gate
 * is applied before the mute gate in `notifications.ts`. It never silences a
 * DM; muting that DM still does, through the mute gate.
 */

import { loadPref, savePref, storedKeys } from "./preferences";
import { getChannelMutesHost } from "./channelMutes";

export const DEFAULT_NOTIFICATION_LEVEL = "mentions" as const;

/** In the order the settings control offers them, loudest first. */
export const NOTIFICATION_LEVELS = ["all", "mentions", "nothing"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

const GLOBAL_KEY = "notificationLevel";
const SERVER_KEY_PREFIX = "notificationLevel";

function serverKey(): string {
  // The per-server host is owned by channel-mutes (set once on connect); a
  // second copy here and a second MainPage setter would be two writers of the
  // same fact.
  const host = getChannelMutesHost();
  return host === null ? SERVER_KEY_PREFIX : `${SERVER_KEY_PREFIX}:${host}`;
}

/** Sentinel fallback for reads: `loadPref`'s typeof guard rejects a nullish
 *  fallback against a stored string, so an invalid level is spelled "". */
const NO_LEVEL = "";

function asLevel(raw: unknown): NotificationLevel | null {
  return typeof raw === "string" && (NOTIFICATION_LEVELS as readonly string[]).includes(raw)
    ? (raw as NotificationLevel)
    : null;
}

function readLevel(key: string): NotificationLevel | null {
  return asLevel(loadPref<unknown>(key, NO_LEVEL));
}

/** The global level, or the default when unset or corrupt. */
export function getGlobalNotificationLevel(): NotificationLevel {
  return readLevel(GLOBAL_KEY) ?? DEFAULT_NOTIFICATION_LEVEL;
}

/**
 * Records the global level once, at startup, before this session writes any
 * storage. A new install gets `mentions` (owner Q8: "Mentions-only for new
 * installs"). Any `owncord:` key already present — a last channel, a status,
 * a theme, a toggle — means the install predates the level and lived with
 * All, so it keeps `all` instead of silently losing channel notifications it
 * used to receive; the user can change it. Recording the new-install default
 * too is what stops a later launch, which will find this session's keys,
 * from mistaking it for an old install.
 */
export function settleNotificationLevelDefault(): void {
  if (readLevel(GLOBAL_KEY) !== null) return;
  savePref(GLOBAL_KEY, hasOwnCordState() ? "all" : DEFAULT_NOTIFICATION_LEVEL);
}

function hasOwnCordState(): boolean {
  return storedKeys().some((key) => key.startsWith("owncord:"));
}

export function setGlobalNotificationLevel(level: NotificationLevel): void {
  savePref(GLOBAL_KEY, level);
}

/**
 * The connected server's override, or null when it has none (so the caller
 * falls back to the global level).
 */
export function getServerNotificationLevel(): NotificationLevel | null {
  const scopedKey = serverKey();
  // A miss at the scoped key reads nothing; there is no pre-scoping legacy key
  // because this preference is new, so no read-through migration is needed.
  return readLevel(scopedKey);
}

export function setServerNotificationLevel(level: NotificationLevel): void {
  savePref(serverKey(), level);
}

export function clearServerNotificationLevel(): void {
  savePref(serverKey(), null);
}

/** The level in force for the connected server: its override, else global. */
export function effectiveNotificationLevel(): NotificationLevel {
  return getServerNotificationLevel() ?? getGlobalNotificationLevel();
}

const CHANNEL_KEY_PREFIX = "channelNotificationLevels";

function channelKey(): string | null {
  const host = getChannelMutesHost();
  return host === null ? null : `${CHANNEL_KEY_PREFIX}:${host}`;
}

/**
 * The connected server's per-channel overrides, as a map. A malformed entry
 * (an unknown level, a non-positive id) is skipped and the rest kept; a
 * corrupt value reads as no overrides. With no host there is nothing to key
 * on, so it is empty.
 */
export function listChannelNotificationOverrides(): ReadonlyMap<number, NotificationLevel> {
  const out = new Map<number, NotificationLevel>();
  const key = channelKey();
  if (key === null) return out;
  const raw = loadPref<unknown>(key, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [idText, value] of Object.entries(raw)) {
    const id = Number(idText);
    const level = asLevel(value);
    if (Number.isInteger(id) && id > 0 && level !== null) out.set(id, level);
  }
  return out;
}

/** The channel's own level, or null when it follows the server default. */
export function getChannelNotificationLevel(channelId: number): NotificationLevel | null {
  return listChannelNotificationOverrides().get(channelId) ?? null;
}

/**
 * Sets a channel's level, or clears it with null (back to the server default).
 * Does nothing without a host: channel ids mean nothing without a server.
 */
export function setChannelNotificationLevel(
  channelId: number,
  level: NotificationLevel | null,
): void {
  const key = channelKey();
  if (key === null || !Number.isInteger(channelId) || channelId <= 0) return;
  const next = new Map(listChannelNotificationOverrides());
  if (level === null) next.delete(channelId);
  else next.set(channelId, level);
  savePref(key, Object.fromEntries(next));
}

/**
 * The level in force for one channel: its override, else the server level. An
 * override wins both ways, so a channel at All notifies in a server at Nothing.
 */
export function channelNotificationLevel(channelId: number): NotificationLevel {
  return getChannelNotificationLevel(channelId) ?? effectiveNotificationLevel();
}

/** `channelNotificationLevel` for many channels, reading storage once. */
export function channelLevelResolver(): (channelId: number) => NotificationLevel {
  const overrides = listChannelNotificationOverrides();
  const fallback = effectiveNotificationLevel();
  return (channelId) => overrides.get(channelId) ?? fallback;
}

export interface NotificationSubject {
  /** Whether the message names the reader (@mention or @everyone). */
  readonly mentioned: boolean;
  /** Whether the message is in a direct-message channel. */
  readonly isDm: boolean;
}

/**
 * Whether `level` permits a notification for `subject`.
 *
 * A direct message is addressed to you, so every level lets it through — a DM
 * is a message to you, not server chatter. `nothing` admits nothing else, the
 * one case that overrides the mute module's "a mention is never silenced"
 * rule for a channel; that is what choosing it means.
 */
export function shouldNotifyForLevel(
  level: NotificationLevel,
  subject: NotificationSubject,
): boolean {
  if (subject.isDm) return true;
  switch (level) {
    case "nothing":
      return false;
    case "all":
      return true;
    case "mentions":
      return subject.mentioned || subject.isDm;
    default:
      return false;
  }
}
