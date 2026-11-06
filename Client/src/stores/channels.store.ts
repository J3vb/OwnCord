/**
 * Channels store — holds channel list, active channel, and unread counts.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { registerRoleIdLookup } from "@lib/presence/roleLookup";
import type {
  ReadyChannel,
  ReadyRole,
  ChannelCreatePayload,
  ChannelUpdatePayload,
  ChannelCategory,
} from "@lib/types";
import { channelFromCreate, channelFromUpdate, readyChannelMap } from "./channelModel";
import type { Channel } from "./channelModel";
import {
  categoryGroups,
  categoryKey,
  groupChannelsByCategory,
  keyOfChannel,
  UNCATEGORIZED_VOICE_CATEGORY,
  voiceFallback,
} from "./channelGroups";
import type { KnownCategory } from "./channelGroups";

export type { Channel } from "./channelModel";
export { readyChannelMap } from "./channelModel";
export type { CategoryRef, KnownCategory } from "./channelGroups";
export {
  UNCATEGORIZED_VOICE_CATEGORY,
  NO_CATEGORY,
  groupLabel,
  categoryGroups,
  displayCategoryOf,
  firstTextInSidebarOrder,
  groupChannelsByCategory,
} from "./channelGroups";

export interface ChannelsState {
  readonly channels: ReadonlyMap<number, Channel>;
  readonly activeChannelId: number | null;
  readonly roles: readonly ReadyRole[];
  /**
   * The full category list, ordered by (position, id). Only a viewer holding
   * MANAGE_CHANNELS is ever sent it (ready.categories and the
   * channel_categories event, written through the dispatcher); for everyone
   * else it stays empty and the groups come from the channels alone.
   */
  readonly categories: readonly ChannelCategory[];
}

const INITIAL_STATE: ChannelsState = {
  channels: new Map(),
  activeChannelId: null,
  roles: [],
  categories: [],
};

export const channelsStore = createStore<ChannelsState>(INITIAL_STATE);

// A server that sends no `role_ids` names the user's one role only; mention
// matching finds its id through the roster (registered here because
// lib/text/mentions sits below the stores).
registerRoleIdLookup((name) => {
  const lower = name.toLowerCase();
  return channelsStore.getState().roles.find((r) => r.name.toLowerCase() === lower)?.id;
});

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

/**
 * The read pointer each channel had when it was last opened — the same
 * snapshot as `unreadOnOpen`, for the same reason: the visit moves the live
 * pointer, and the NEW line has to stay where the reader had got to. Absent
 * (or undefined) means the server sent no pointer.
 */
const pointerOnOpen = new Map<number, number | undefined>();

/** The read pointer this channel had when it was last opened (undefined = none sent). */
export function getPointerOnOpen(channelId: number): number | undefined {
  return pointerOnOpen.get(channelId);
}

/** Unread count this channel had when it was last opened (0 = nothing new). */
export function getUnreadOnOpen(channelId: number): number {
  return unreadOnOpen.get(channelId) ?? 0;
}

/** Bulk set channels from the ready payload. Converts ReadyChannel[] to Map. */
export function setChannels(channels: readonly ReadyChannel[]): void {
  // A fresh ready payload restates unread from the server; any snapshot from
  // the previous connection describes a read position that no longer applies.
  unreadOnOpen.clear();
  pointerOnOpen.clear();
  const map = readyChannelMap(channels);
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

/**
 * Replace the manager's category list wholesale (ready.categories or a
 * channel_categories frame), kept in the server's (position, id) order.
 */
export function setCategories(categories: readonly ChannelCategory[]): void {
  const sorted = categories.toSorted((a, b) => a.position - b.position || a.id - b.id);
  channelsStore.setState((prev) => ({ ...prev, categories: sorted }));
}

/** Bulk set roles from the ready payload. */
export function setRoles(roles: readonly ReadyRole[]): void {
  channelsStore.setState((prev) => ({ ...prev, roles }));
}

/**
 * Reset the entire store to its initial (empty) state — e.g. on logout.
 * Also clears unreadOnOpen: without this, setChannels' DM-row carry (above)
 * re-inserts the previous server's DM channel rows into the next server's
 * channel map on the next login, and a stale read-position snapshot from the
 * old server would otherwise leak into the new one.
 */
export function resetChannelsStore(): void {
  unreadOnOpen.clear();
  pointerOnOpen.clear();
  channelsStore.setState(() => INITIAL_STATE);
}
void registerSessionReset("channels:store", resetChannelsStore); // app-lifetime

/** Look up a role ID by name (case-insensitive). Returns undefined if not found. */
export function getRoleIdByName(name: string): number | undefined {
  const roles = channelsStore.getState().roles;
  const match = roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
  return match?.id;
}

/** Add a single channel from a channel_create event. Idempotent: a re-send
 *  keeps the per-user fields the frame does not carry (see channelFromCreate). */
export function addChannel(channel: ChannelCreatePayload): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.set(channel.id, channelFromCreate(channel, prev.channels.get(channel.id)));
    return { ...prev, channels: next };
  });
}

/** Apply a channel_update broadcast immutably; an absent field is left alone. */
export function updateChannel(update: ChannelUpdatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(update.id);
    if (existing === undefined) {
      return prev;
    }
    const next = new Map(prev.channels);
    next.set(update.id, channelFromUpdate(existing, update));
    return { ...prev, channels: next };
  });
}

/**
 * Record the server-confirmed acknowledgement of a labelled channel.
 * Ignored for an unknown or unlabelled channel, which has nothing to consent to.
 */
export function setNsfwAcknowledged(id: number, acknowledged: boolean): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(id);
    if (existing === undefined || !existing.nsfw) return prev;
    if ((existing.nsfwAcknowledged === true) === acknowledged) return prev;
    const next = new Map(prev.channels);
    next.set(id, { ...existing, nsfwAcknowledged: acknowledged });
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
 *
 * `clearUnread: false` selects without zeroing the badge: the ready-time
 * auto-select (and the last-channel restore) is not the user opening the
 * channel, so a channel they never looked at keeps its unread count until it
 * is actually mounted. The `unreadOnOpen` snapshot is taken either way, so the
 * NEW divider still lands above the first unseen message on the real visit.
 */
export function setActiveChannel(id: number | null, options?: { clearUnread?: boolean }): void {
  // Snapshot before clearing — this is the last moment the reader's position is
  // knowable (see unreadOnOpen). Done outside setState so the updater stays a
  // pure function of previous state.
  if (id !== null) {
    unreadOnOpen.set(id, channelsStore.getState().channels.get(id)?.unreadCount ?? 0);
    pointerOnOpen.set(id, channelsStore.getState().channels.get(id)?.lastReadMessageId);
  }
  const clear = options?.clearUnread ?? true;
  channelsStore.setState((prev) => {
    if (id === null) {
      return { ...prev, activeChannelId: null };
    }
    const existing = prev.channels.get(id);
    if (
      !clear ||
      existing === undefined ||
      (existing.unreadCount === 0 && existing.mentionCount === 0)
    ) {
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
 * The position a new channel needs to land at the bottom of the group it will
 * be shown under: one past the highest position among the channels displayed
 * in that group (the synthetic "Voice" group counts uncategorized voice
 * channels; `categoryId` 0 is uncategorized). A group with no channels yet sorts
 * at the bottom of the whole list. The server stores a provided position as
 * given and a create with none sends 0, which lands at the top.
 */
export function nextPositionInCategory(categoryId: number, type: Channel["type"]): number {
  return nextPositionInGroup(categoryId > 0 ? categoryKey(categoryId) : voiceFallback(type));
}

/** `nextPositionInCategory` for a legacy (name-keyed) group on a server without ids. */
export function nextPositionInCategoryNamed(category: string, type: Channel["type"]): number {
  return nextPositionInGroup(category === "" ? voiceFallback(type) : category);
}

function nextPositionInGroup(target: string | null): number {
  return channelsStore.select((s) => {
    let groupMax = -1;
    let allMax = -1;
    for (const channel of s.channels.values()) {
      if (channel.type === "dm") continue;
      if (channel.position > allMax) allMax = channel.position;
      if (keyOfChannel(channel) === target && channel.position > groupMax) {
        groupMax = channel.position;
      }
    }
    return (groupMax >= 0 ? groupMax : allMax) + 1;
  });
}

/** The categories a channel can be filed under, in sidebar order (see KnownCategory). */
export function getKnownCategories(categories: readonly ChannelCategory[]): KnownCategory[] {
  return channelsStore.select((s) =>
    categoryGroups(s.channels, categories)
      .filter((g) => g.name !== null && g.key !== UNCATEGORIZED_VOICE_CATEGORY)
      .map((g) => ({ id: g.categoryId, name: g.name ?? "" })),
  );
}

/** The groups keyed by `CategoryGroup.key`, in sidebar order. */
export function getChannelsByCategory(
  categories: readonly ChannelCategory[],
): Map<string | null, readonly Channel[]> {
  return channelsStore.select((s) => groupChannelsByCategory(s.channels, categories));
}

/**
 * Increment unread count for a channel, unless it is the active channel.
 *
 * `evenIfActive` opts out of that skip: "active" normally means
 * "the user is watching the live tail" — the reason a badge would be
 * redundant there — but the active channel's loaded window can be detached
 * from the live tail (a jump to an old permalink/reply/search hit), in which
 * case the message is genuinely unseen and must still count. Callers own
 * deciding when that applies; this still always skips an unknown channel id.
 */
export function incrementUnread(channelId: number, evenIfActive = false): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId && !evenIfActive) {
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
 *
 * `evenIfActive` mirrors incrementUnread's escape hatch — see its doc for why.
 */
export function incrementMention(channelId: number, evenIfActive = false): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId && !evenIfActive) {
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

/**
 * Record an incoming channel message: bumps unread (and mention, when
 * `isMention`) unless `messageId` is already reflected in the channel's
 * watermark — mirrors dm.store's `updateDmLastMessage`.
 *
 * A message delivered between the server's registerNow and
 * buildReady is both counted in `ready`'s snapshot (unread_count/
 * last_message_id already advanced) AND redelivered as a queued
 * chat_message once the socket drains. Both counters must sit behind the
 * SAME watermark read in one setState — splitting the guard across
 * incrementUnread/incrementMention can't work, since the first call would
 * already have advanced lastMessageId before the second one checked it.
 *
 * `evenIfActive` mirrors incrementUnread's escape hatch — see its doc.
 */
export function noteChannelMessage(
  channelId: number,
  messageId: number,
  isMention: boolean,
  evenIfActive = false,
): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId && !evenIfActive) {
      return prev;
    }
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const isReplay = existing.lastMessageId !== null && messageId <= existing.lastMessageId;
    if (isReplay) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: existing.unreadCount + 1,
      mentionCount: isMention ? existing.mentionCount + 1 : existing.mentionCount,
      lastMessageId: messageId,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Set a channel's mention count from the server's authoritative total.
 * A mention that lands in a channel the user is not viewing never reaches this
 * client through the channel topic, so the server pushes a per-user
 * `mention_count` frame with the new total instead. Replacing rather than
 * incrementing keeps the count convergent across a lost or duplicated frame.
 *
 * `unreadCount` is deliberately untouched: the frame says nothing about it, and
 * a guild channel's taskbar/tray badge counts only mentions anyway. A no-op for
 * a channel this client does not know, so a stale frame cannot invent a row.
 */
export function setMentionCount(channelId: number, count: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined || existing.mentionCount === count) {
      return prev;
    }
    const updated: Channel = { ...existing, mentionCount: count };
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

/**
 * Set a channel's read pointer, and optionally its counts, outright (the
 * optimistic move of a mark, or the server's `read_state`). A no-op for a
 * channel this client does not know.
 */
export function setReadPointer(
  channelId: number,
  pointer: number | undefined,
  counts?: { readonly unread: number; readonly mention: number },
): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined) return prev;
    const map = new Map(prev.channels);
    map.set(channelId, {
      ...existing,
      lastReadMessageId: pointer,
      ...(counts && { unreadCount: counts.unread, mentionCount: counts.mention }),
    });
    return { ...prev, channels: map };
  });
}

/** Whether `channelId` is the server's AFK voice channel. */
export function isAfkChannel(channelId: number | null): boolean {
  return channelId !== null && channelsStore.getState().channels.get(channelId)?.afk === true;
}
