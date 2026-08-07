/**
 * DM store — holds direct message channel list and unread state.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import { channelsStore } from "@stores/channels.store";

export interface DmUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
  readonly status: string;
  /** Nickname to render instead of `username`. "" = unset. */
  readonly displayName?: string;
}

export interface DmChannel {
  readonly channelId: number;
  /**
   * The other participant of a 1:1 DM. For a group it is the first of
   * `participants`; anything that must be correct for groups reads
   * `participants` instead. Kept because most 1:1 call sites want exactly one
   * user and would otherwise all index into an array.
   */
  readonly recipient: DmUser;
  /** Everyone in the DM except the current user. Never empty for a live DM. */
  readonly participants: readonly DmUser[];
  /** Optional group name. "" for a 1:1 DM and for an unnamed group. */
  readonly name: string;
  /** True for a group DM (3+ participants at creation). */
  readonly isGroup: boolean;
  readonly lastMessageId: number | null;
  readonly lastMessage: string;
  readonly lastMessageAt: string;
  readonly unreadCount: number;
  /**
   * Unread messages in this DM that mention the current user. Kept independent
   * of unreadCount so the red mention badge can outrank the plain one, exactly
   * as it does for channels.
   */
  readonly mentionCount: number;
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

/**
 * Add or update a single DM channel (from a `dm_channel_open` event).
 *
 * Local unread and mention counts survive the replace when the incoming
 * payload carries none. `dm_channel_open` is now also how a *membership*
 * change arrives — a group created, renamed, or left — and those payloads have
 * no unread state to report, so taking their zeroes literally would clear
 * everyone's badge every time somebody renamed a group. Between two `ready`s
 * the client's own count is the authoritative one (it is what the incoming
 * messages incremented), and a genuine reopen has nothing to lose: its local
 * count is zero too.
 */
export function addDmChannel(channel: DmChannel): void {
  dmStore.setState((prev) => {
    const existing = prev.channels.find((c) => c.channelId === channel.channelId);
    const filtered = prev.channels.filter((c) => c.channelId !== channel.channelId);
    const merged: DmChannel =
      existing === undefined
        ? channel
        : {
            ...channel,
            unreadCount: channel.unreadCount > 0 ? channel.unreadCount : existing.unreadCount,
            mentionCount: channel.mentionCount > 0 ? channel.mentionCount : existing.mentionCount,
            // Same reasoning for the preview: a rename does not know what the
            // last message was, and blanking it would leave the row emptier
            // than before the rename.
            lastMessageId: channel.lastMessageId ?? existing.lastMessageId,
            lastMessage: channel.lastMessage !== "" ? channel.lastMessage : existing.lastMessage,
            lastMessageAt:
              channel.lastMessageAt !== "" ? channel.lastMessageAt : existing.lastMessageAt,
          };
    return { channels: [merged, ...filtered] };
  });
}

/** Remove a DM channel from the list (from dm_channel_close event). */
export function removeDmChannel(channelId: number): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.filter((c) => c.channelId !== channelId),
  }));
}

/**
 * Local close/removal for a DM that is gone — closed here, or reported gone
 * by the server (`dm_channel_close`, possibly from another signed-in
 * device). Drops it from dmStore and, if it was the channel being viewed,
 * runs `fallback` so the message list/composer don't stay mounted against a
 * channel the server no longer recognizes. `fallback` lets each caller pick
 * its own landing spot — the sidebar restores the channel visited before the
 * DM; a background close just needs somewhere safe.
 */
export function closeDmLocally(channelId: number, fallback: () => void): void {
  const wasActive = channelsStore.getState().activeChannelId === channelId;
  removeDmChannel(channelId);
  if (wasActive) fallback();
}

/** Update last message info for a DM channel (on new message) and increment unread.
 *  Moves the channel to the top of the list so new messages are always visible. */
export function updateDmLastMessage(
  channelId: number,
  messageId: number,
  content: string,
  timestamp: string,
): void {
  dmStore.setState((prev) => {
    const updated = prev.channels.find((c) => c.channelId === channelId);
    if (updated === undefined) return prev;
    const rest = prev.channels.filter((c) => c.channelId !== channelId);
    return {
      channels: [
        {
          ...updated,
          lastMessageId: messageId,
          lastMessage: content,
          lastMessageAt: timestamp,
          unreadCount: updated.unreadCount + 1,
        },
        ...rest,
      ],
    };
  });
}

/** Update last message preview for a DM channel without incrementing unread count.
 *  Used for own messages and messages in the currently focused DM.
 *  Moves the channel to the top of the list so active conversations stay visible. */
export function updateDmLastMessagePreview(
  channelId: number,
  messageId: number,
  content: string,
  timestamp: string,
): void {
  dmStore.setState((prev) => {
    const updated = prev.channels.find((c) => c.channelId === channelId);
    if (updated === undefined) return prev;
    const rest = prev.channels.filter((c) => c.channelId !== channelId);
    return {
      channels: [
        { ...updated, lastMessageId: messageId, lastMessage: content, lastMessageAt: timestamp },
        ...rest,
      ],
    };
  });
}

/** Clear the unread and mention counts for a DM channel — they clear together,
 *  matching channels.store.clearUnread and the server's read-state advance. */
export function clearDmUnread(channelId: number): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.map((c) =>
      c.channelId === channelId ? { ...c, unreadCount: 0, mentionCount: 0 } : c,
    ),
  }));
}

/**
 * The label a DM renders under.
 *
 * One function so the sidebar row, the chat header, the quick switcher and the
 * notification title cannot disagree about what a conversation is called —
 * which for a group with no name they would, since each would pick its own
 * order and cut-off for the joined member list.
 *
 * A named group uses its name. An unnamed group joins its members' names, and
 * past three says "and N more" rather than growing without bound. A 1:1 DM is
 * named by the person on the other end.
 */
export function dmDisplayName(dm: DmChannel): string {
  if (dm.name !== "") return dm.name;
  const names = dm.participants.map((p) => (p.displayName ?? "") || p.username);
  if (names.length === 0) return dm.recipient.username;
  if (!dm.isGroup) return names[0]!;
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Increment a DM's mention count. Callers also call updateDmLastMessage — a
 *  mention is always an unread too. */
export function incrementDmMention(channelId: number): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.map((c) =>
      c.channelId === channelId ? { ...c, mentionCount: c.mentionCount + 1 } : c,
    ),
  }));
}
