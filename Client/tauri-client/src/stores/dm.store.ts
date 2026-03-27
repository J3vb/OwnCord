/**
 * DM store — holds direct message channel list and unread state.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";

export interface DmUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
  readonly status: string;
}

export interface DmChannel {
  readonly channelId: number;
  readonly recipient: DmUser;
  readonly lastMessageId: number | null;
  readonly lastMessage: string;
  readonly lastMessageAt: string;
  readonly unreadCount: number;
}

export interface DmState {
  readonly channels: readonly DmChannel[];
}

const INITIAL: DmState = { channels: [] };

export const dmStore = createStore<DmState>(INITIAL);

/** Bulk-set DM channels from ready payload. */
export function setDmChannels(channels: readonly DmChannel[]): void {
  dmStore.setState(() => ({ channels }));
}

/** Add or update a single DM channel (from dm_channel_open event). */
export function addDmChannel(channel: DmChannel): void {
  dmStore.setState((prev) => {
    const filtered = prev.channels.filter((c) => c.channelId !== channel.channelId);
    return { channels: [channel, ...filtered] };
  });
}

/** Remove a DM channel from the list (from dm_channel_close event). */
export function removeDmChannel(channelId: number): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.filter((c) => c.channelId !== channelId),
  }));
}

/** Update last message info for a DM channel (on new message). */
export function updateDmLastMessage(
  channelId: number,
  messageId: number,
  content: string,
  timestamp: string,
): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.map((c) =>
      c.channelId === channelId
        ? { ...c, lastMessageId: messageId, lastMessage: content, lastMessageAt: timestamp, unreadCount: c.unreadCount + 1 }
        : c,
    ),
  }));
}

/** Clear unread count for a DM channel. */
export function clearDmUnread(channelId: number): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.map((c) =>
      c.channelId === channelId ? { ...c, unreadCount: 0 } : c,
    ),
  }));
}
