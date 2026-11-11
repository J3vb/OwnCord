/**
 * The channel sidebar's public types: what a drop reports, the moderation
 * callbacks and the options the page passes in. Kept apart from the component
 * so the menus and the drag code import them without importing it.
 */

import type { CategoryRef, Channel } from "@stores/channels.store";
import type { ChannelType } from "@lib/types";

export interface ChannelReorderData {
  readonly channelId: number;
  readonly newPosition: number;
  /** Position before the optimistic move, so a failed save can roll back. */
  readonly previousPosition: number;
  /**
   * Present on the one entry of a drop that also moves the channel to another
   * category: its PATCH then carries `category_id`, and a failed save
   * rolls back the category as well as the position.
   */
  readonly category?: {
    readonly previous: ChannelCategoryFields;
    readonly next: ChannelCategoryFields;
  };
}

/** The channel fields that say which category it sits under, as the store holds them. */
export interface ChannelCategoryFields {
  /** 0 or undefined when the channel is in no category. */
  readonly categoryId: number | undefined;
  /** The category's name ("" or null for none). */
  readonly category: string | null;
  readonly categoryPosition: number | undefined;
}

/** Moderator actions on another user's voice session. Supplied by the page,
 *  which owns the WS socket; the sidebar only decides whether to offer them. */
export interface VoiceModerationCallbacks {
  readonly onServerMute: (channelId: number, userId: number, muted: boolean) => void;
  readonly onServerDeafen: (channelId: number, userId: number, deafened: boolean) => void;
  readonly onMove: (userId: number, toChannelId: number) => void;
  readonly onDisconnect: (userId: number) => void;
}

export interface ChannelSidebarOptions {
  readonly onVoiceJoin: (channelId: number) => void;
  /** Called when the user clicks the voice channel they are already in. Leaving
   *  is the voice widget's Disconnect, never a channel click. */
  readonly onOpenCall: () => void;
  /** Voice moderation wiring; the moderation menu section is hidden without it. */
  readonly onVoiceModerate?: VoiceModerationCallbacks;
  /**
   * Called when the user clicks the "+" on a category header (or the empty-state
   * button). `category` is the group's category: its id (0 on a server that sends
   * none, or for "no category") and name ("" for none). `type` is a hint for the
   * synthetic Voice group, whose "+" most likely means another voice channel.
   */
  readonly onCreateChannel?: (category: CategoryRef, type?: ChannelType) => void;
  /** Category management (MANAGE_CHANNELS). The header menu hides an entry whose callback is absent. */
  readonly onCreateCategory?: () => void;
  readonly onRenameCategory?: (category: CategoryRef) => void;
  readonly onDeleteCategory?: (category: CategoryRef) => void;
  readonly onMoveCategory?: (category: CategoryRef, direction: -1 | 1) => void;
  /** Called when the user right-clicks a channel and selects Edit. */
  readonly onEditChannel?: (channel: Channel) => void;
  /** Called when the user right-clicks a channel and selects Delete. */
  readonly onDeleteChannel?: (channel: Channel) => void;
  /** Called when the user drags a channel to a new position. */
  readonly onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void;
  /**
   * Called when a manager drops a category header on another category's header
   * or group: `categoryId` goes before (or after) `targetId`. The page
   * sends the new order; nothing is applied locally.
   */
  readonly onReorderCategory?: (categoryId: number, targetId: number, before: boolean) => void;
  /** Bulk-delete the newest `count` messages; gated on MANAGE_MESSAGES. */
  readonly onPurgeChannel?: (channel: Channel, count: number) => Promise<void>;
  /** Called when the user picks Invite People from a channel's menu. */
  readonly onInviteFromChannel?: (channel: Channel) => void;
  /** Called when the user clicks a voice user row to watch their stream. */
  readonly onWatchStream?: (userId: number) => void;
  /** A followed thread's row was clicked: open its parent channel and the thread panel. */
  readonly onOpenThread?: (threadId: number, parentId: number) => void;
  /** A parent's "N more" row was clicked: open its channel and the Threads list. */
  readonly onOpenThreadList?: (parentId: number) => void;
  /** The row menu's Unfollow. */
  readonly onUnfollowThread?: (threadId: number) => void;
  /** The row menu's Mark as Read. */
  readonly onMarkThreadRead?: (threadId: number) => void;
}
