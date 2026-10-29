import { isChannelMuted } from "./channel-mutes";

interface DmUnreadCounts {
  readonly channelId: number;
  readonly unreadCount: number;
  readonly mentionCount: number;
}

/**
 * The DM unread total shown on the DM header and on the rail's Home button.
 * A muted conversation adds only its mentions: a mention is the one thing a
 * mute never swallows.
 */
export function totalDmUnread(channels: readonly DmUnreadCounts[]): number {
  return channels.reduce((sum, c) => sum + dmUnreadCount(c), 0);
}

/** One conversation's share of that total. */
export function dmUnreadCount(c: DmUnreadCounts): number {
  return isChannelMuted(c.channelId) ? c.mentionCount : c.unreadCount;
}
