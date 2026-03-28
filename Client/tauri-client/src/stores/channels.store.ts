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
  readonly position: number;
  readonly unreadCount: number;
  readonly lastMessageId: number | null;
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

/** Bulk set channels from the ready payload. Converts ReadyChannel[] to Map. */
export function setChannels(channels: readonly ReadyChannel[]): void {
  const map = new Map<number, Channel>();
  for (const ch of channels) {
    map.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      category: ch.category,
      position: ch.position,
      unreadCount: ch.unread_count ?? 0,
      lastMessageId: ch.last_message_id ?? null,
    });
  }
  channelsStore.setState((prev) => ({
    ...prev,
    channels: map,
  }));
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

/** Add a single channel from a channel_create event. */
export function addChannel(channel: ChannelCreatePayload): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.set(channel.id, {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      category: channel.category,
      position: channel.position,
      unreadCount: 0,
      lastMessageId: null,
    });
    return { ...prev, channels: next };
  });
}

/** Update a channel's name and/or position immutably. */
export function updateChannel(update: ChannelUpdatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(update.id);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.position !== undefined ? { position: update.position } : {}),
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

/** Set the active channel by id (or null to deselect). Clears unread count for the activated channel. */
export function setActiveChannel(id: number | null): void {
  channelsStore.setState((prev) => {
    if (id === null) {
      return { ...prev, activeChannelId: null };
    }
    const existing = prev.channels.get(id);
    if (existing === undefined || existing.unreadCount === 0) {
      return { ...prev, activeChannelId: id };
    }
    const updated: Channel = { ...existing, unreadCount: 0 };
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

/** Group channels by category, sorted by position within each group. */
export function getChannelsByCategory(): Map<string | null, Channel[]> {
  return channelsStore.select((s) => {
    const grouped = new Map<string | null, Channel[]>();
    for (const channel of s.channels.values()) {
      // DM channels are shown in the DM sidebar, not the channel list
      if (channel.type === "dm") continue;
      const existing = grouped.get(channel.category);
      if (existing !== undefined) {
        existing.push(channel);
      } else {
        grouped.set(channel.category, [channel]);
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

/** Clear unread count for a channel. */
export function clearUnread(channelId: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: 0,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}
