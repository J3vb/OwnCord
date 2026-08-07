/**
 * Channels store — holds channel list, active channel, and unread counts.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ReadyChannel,
  ReadyRole,
  ChannelCreatePayload,
  ChannelUpdatePayload,
  ChannelType,
} from "@lib/types";

export interface Channel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  /** Channel topic ("" = none). */
  readonly topic: string;
  readonly position: number;
  readonly unreadCount: number;
  /**
   * Unread messages here that mention the current user (directly or via
   * @everyone/@here). Always a subset of unreadCount; drives the red mention
   * badge, which outranks the plain unread badge.
   */
  readonly mentionCount: number;
  readonly lastMessageId: number | null;
  /** Whether the current user may post here (drives the composer affordance). */
  readonly canSend: boolean;
  /** Per-channel cooldown in seconds (0 = off). Drives the composer countdown. */
  readonly slowMode: number;
  /**
   * Flagged as possibly carrying sensitive content.
   *
   * The server stores and broadcasts this and does nothing else with it — no
   * filtering, no restriction on who may read or post — so every consequence
   * is this client's: a one-time-per-session age gate before the channel's
   * messages are shown, and a marker on the sidebar row.
   */
  readonly nsfw: boolean;
  /**
   * Voice capacity limits (0 = unlimited). The server enforces both on join
   * (CHANNEL_FULL / VIDEO_LIMIT); these copies exist so the sidebar can show
   * "3/5" and the client never has to guess why a join was refused.
   */
  readonly voiceMaxUsers: number;
  readonly voiceMaxVideo: number;
}

export interface ChannelsState {
  readonly channels: ReadonlyMap<number, Channel>;
  readonly activeChannelId: number | null;
  readonly roles: readonly ReadyRole[];
}

const INITIAL_STATE: ChannelsState = {
  channels: new Map(),
  activeChannelId: null,
  roles: [],
};

export const channelsStore = createStore<ChannelsState>(INITIAL_STATE);

/**
 * How many unread messages each channel had at the moment it was last opened.
 *
 * Opening a channel clears its badge immediately, which destroys the only
 * record of where the reader had got to — so the value is snapshotted here
 * first. MessageList reads it to place the "NEW" divider above the first
 * message the reader has not seen. Kept outside the store state because it is
 * not reactive: it is read once when the list mounts, and a subscriber firing
 * on it would just re-render the list for no visible change.
 */
const unreadOnOpen = new Map<number, number>();

/** Unread count this channel had when it was last opened (0 = nothing new). */
export function getUnreadOnOpen(channelId: number): number {
  return unreadOnOpen.get(channelId) ?? 0;
}

/** Bulk set channels from the ready payload. Converts ReadyChannel[] to Map. */
export function setChannels(channels: readonly ReadyChannel[]): void {
  // A fresh ready payload restates unread from the server; any snapshot from
  // the previous connection describes a read position that no longer applies.
  unreadOnOpen.clear();
  const map = new Map<number, Channel>();
  for (const ch of channels) {
    map.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      category: ch.category,
      topic: ch.topic ?? "",
      position: ch.position,
      unreadCount: ch.unread_count ?? 0,
      mentionCount: ch.mention_count ?? 0,
      lastMessageId: ch.last_message_id ?? null,
      // The current server always sends can_send; older servers omit it, in
      // which case we default permissive (no gating) rather than guessing.
      canSend: ch.can_send ?? true,
      slowMode: ch.slow_mode ?? 0,
      // Older servers omit these; "absent" reads as unflagged / unlimited,
      // which is also what an unconfigured channel sends.
      nsfw: ch.nsfw ?? false,
      voiceMaxUsers: ch.voice_max_users ?? 0,
      voiceMaxVideo: ch.voice_max_video ?? 0,
    });
  }
  channelsStore.setState((prev) => {
    // The ready payload never includes DM rows (those arrive via dm_channels
    // and are synthesized into this store on selection), so carry them across
    // the rebuild — destroying them would break call/profile actions for the
    // DM the user is currently viewing until they re-click it.
    for (const [id, ch] of prev.channels) {
      if (ch.type === "dm" && !map.has(id)) {
        map.set(id, ch);
      }
    }
    return { ...prev, channels: map };
  });
}

/** Bulk set roles from the ready payload. */
export function setRoles(roles: readonly ReadyRole[]): void {
  channelsStore.setState((prev) => ({ ...prev, roles }));
}

/** Look up a role ID by name (case-insensitive). Returns undefined if not found. */
export function getRoleIdByName(name: string): number | undefined {
  const roles = channelsStore.getState().roles;
  const match = roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
  return match?.id;
}

/** Add a single channel from a channel_create event. The server re-sends
 *  channel_create to still-visible clients on role/override edits, so the add
 *  must be idempotent: the broadcast carries no per-user data, and a re-add
 *  must preserve the existing row's per-user fields instead of resetting them. */
export function addChannel(channel: ChannelCreatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channel.id);
    const next = new Map(prev.channels);
    next.set(channel.id, {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      category: channel.category,
      topic: channel.topic ?? "",
      position: channel.position,
      unreadCount: existing?.unreadCount ?? 0,
      mentionCount: existing?.mentionCount ?? 0,
      lastMessageId: existing?.lastMessageId ?? null,
      // A targeted channel_create from RefreshChannelVisibility carries this
      // viewer's own can_send, so a live role/override edit updates the
      // composer without waiting for a reconnect. The field is absent on the
      // shared-buffer broadcasts (one frame, many recipients) and on older
      // servers — keep the existing verdict there, and default permissive for
      // a genuinely new channel. The server enforces regardless.
      canSend: channel.can_send ?? existing?.canSend ?? true,
      slowMode: channel.slow_mode ?? 0,
      nsfw: channel.nsfw ?? false,
      voiceMaxUsers: channel.voice_max_users ?? 0,
      voiceMaxVideo: channel.voice_max_video ?? 0,
    });
    return { ...prev, channels: next };
  });
}

/**
 * Apply a channel_update broadcast immutably.
 *
 * Every field is optional and an absent one is left alone rather than reset:
 * the payload from an older server carries fewer keys than this one knows
 * about, and treating "absent" as "cleared" would blank a channel's topic or
 * drop its NSFW flag on the first update after connecting.
 */
export function updateChannel(update: ChannelUpdatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(update.id);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.topic !== undefined ? { topic: update.topic } : {}),
      // "" is a real value here — it means "no category" — so only undefined
      // is treated as "not sent".
      ...(update.category !== undefined ? { category: update.category } : {}),
      ...(update.position !== undefined ? { position: update.position } : {}),
      ...(update.slow_mode !== undefined ? { slowMode: update.slow_mode } : {}),
      ...(update.nsfw !== undefined ? { nsfw: update.nsfw } : {}),
      ...(update.voice_max_users !== undefined ? { voiceMaxUsers: update.voice_max_users } : {}),
      ...(update.voice_max_video !== undefined ? { voiceMaxVideo: update.voice_max_video } : {}),
    };
    const next = new Map(prev.channels);
    next.set(update.id, updated);
    return { ...prev, channels: next };
  });
}

/** Update a single channel's position immutably. */
export function updateChannelPosition(id: number, position: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(id);
    if (existing === undefined || existing.position === position) {
      return prev;
    }
    const updated: Channel = { ...existing, position };
    const next = new Map(prev.channels);
    next.set(id, updated);
    return { ...prev, channels: next };
  });
}

/** Remove a channel. Clears activeChannelId if it was the removed channel. */
export function removeChannel(id: number): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.delete(id);
    return {
      ...prev,
      channels: next,
      activeChannelId: prev.activeChannelId === id ? null : prev.activeChannelId,
    };
  });
}

/**
 * Set the active channel by id (or null to deselect). Clears the unread and
 * mention counts for the activated channel — the server's channel_focus does
 * the same server-side, so the badges must not survive the visit locally.
 */
export function setActiveChannel(id: number | null): void {
  // Snapshot before clearing — this is the last moment the reader's position is
  // knowable (see unreadOnOpen). Done outside setState so the updater stays a
  // pure function of previous state.
  if (id !== null) {
    unreadOnOpen.set(id, channelsStore.getState().channels.get(id)?.unreadCount ?? 0);
  }
  channelsStore.setState((prev) => {
    if (id === null) {
      return { ...prev, activeChannelId: null };
    }
    const existing = prev.channels.get(id);
    if (existing === undefined || (existing.unreadCount === 0 && existing.mentionCount === 0)) {
      return { ...prev, activeChannelId: id };
    }
    const updated: Channel = { ...existing, unreadCount: 0, mentionCount: 0 };
    const next = new Map(prev.channels);
    next.set(id, updated);
    return { ...prev, activeChannelId: id, channels: next };
  });
}

/** Get the currently active Channel object, or null. */
export function getActiveChannel(): Channel | null {
  return channelsStore.select((s) => {
    if (s.activeChannelId === null) {
      return null;
    }
    return s.channels.get(s.activeChannelId) ?? null;
  });
}

/**
 * The group header an uncategorized VOICE channel falls back to.
 *
 * Categories are free text and a channel of any type may carry any of them, so
 * a voice channel groups under whatever category it has — there is no magic
 * name that makes a category "the voice one". Only a voice channel with no
 * category at all needs somewhere to go, and mixing it into the unnamed group
 * next to uncategorized text channels reads as a bug, so it gets this group.
 */
export const UNCATEGORIZED_VOICE_CATEGORY = "Voice";

/** The category header a channel is displayed under. */
export function displayCategoryOf(channel: Channel): string | null {
  if (channel.category !== null && channel.category !== "") {
    return channel.category;
  }
  return channel.type === "voice" ? UNCATEGORIZED_VOICE_CATEGORY : null;
}

/** Every distinct category name currently in use, sorted, for suggestion lists. */
export function getKnownCategories(): string[] {
  return channelsStore.select((s) => {
    const names = new Set<string>();
    for (const channel of s.channels.values()) {
      if (channel.type === "dm") continue;
      if (channel.category !== null && channel.category !== "") {
        names.add(channel.category);
      }
    }
    return [...names].toSorted((a, b) => a.localeCompare(b));
  });
}

/** Group channels by category, sorted by position within each group. */
export function getChannelsByCategory(): Map<string | null, Channel[]> {
  return channelsStore.select((s) => {
    const grouped = new Map<string | null, Channel[]>();
    for (const channel of s.channels.values()) {
      // DM channels are shown in the DM sidebar, not the channel list
      if (channel.type === "dm") continue;
      const category = displayCategoryOf(channel);
      const existing = grouped.get(category);
      if (existing !== undefined) {
        existing.push(channel);
      } else {
        grouped.set(category, [channel]);
      }
    }
    for (const channels of grouped.values()) {
      channels.sort((a, b) => a.position - b.position);
    }
    return grouped;
  });
}

/** Increment unread count for a channel, unless it is the active channel. */
export function incrementUnread(channelId: number): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId) {
      return prev;
    }
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: existing.unreadCount + 1,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Increment the mention count for a channel, unless it is the active channel.
 * Callers also call incrementUnread — a mention is always an unread too, and
 * the two counters are kept independent so the badge can outrank.
 */
export function incrementMention(channelId: number): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId) {
      return prev;
    }
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      mentionCount: existing.mentionCount + 1,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/** Clear the unread and mention counts for a channel — they clear together. */
export function clearUnread(channelId: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: 0,
      mentionCount: 0,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}
