/**
 * SidebarDmHelpers — DM-related business logic helpers used by both the
 * embedded DM section (channels mode) and the full DM sidebar (dms mode).
 */

import { type ApiClient, errorText } from "@lib/api";
import type { ToastContainer } from "@components/Toast";
import type { DmConversation } from "@components/DmSidebar";
import { setSidebarMode, setActiveDmUser } from "@stores/ui.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import {
  dmStore,
  clearDmUnread,
  addDmChannel,
  dmDisplayName,
  addDmToChannelsStore,
  dmChannelFromPayload,
} from "@stores/dm.store";
import type { DmChannel, DmUser } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { isChannelMuted } from "@lib/channel-mutes";
import { connectText } from "../../i18n/connect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DmHelperDeps {
  readonly api: ApiClient;
  readonly getToast: () => ToastContainer | null;
  readonly getChannelBeforeDm: () => number | null;
  readonly setChannelBeforeDm: (id: number | null) => void;
}

// ---------------------------------------------------------------------------
// selectDmConversation
// ---------------------------------------------------------------------------

/**
 * Switch the UI to a specific DM conversation. Saves the current non-DM
 * channel so it can be restored when the user navigates back.
 */
export function selectDmConversation(dmChannel: DmChannel, deps: DmHelperDeps): void {
  // Save current channel so we can restore it when user clicks "Back"
  // Only save if the current channel is a real text/voice channel, not another DM
  const currentActive = channelsStore.getState().activeChannelId;
  if (currentActive !== null) {
    const currentCh = channelsStore.getState().channels.get(currentActive);
    if (currentCh !== undefined && currentCh.type !== "dm") {
      deps.setChannelBeforeDm(currentActive);
    }
  }

  // A group has no single "DM user"; the sidebar's active marker keys on the
  // active channel instead. This is kept for the 1:1 case, where other parts
  // (the profile sidebar) still ask "who am I talking to".
  setActiveDmUser(dmChannel.isGroup ? null : dmChannel.recipient.id);
  setSidebarMode("dms");
  clearDmUnread(dmChannel.channelId);

  // Add the DM channel to channelsStore so ChannelController can load it
  addDmToChannelsStore(dmChannel);
  setActiveChannel(dmChannel.channelId);
}

// ---------------------------------------------------------------------------
// handleCreateDm
// ---------------------------------------------------------------------------

/**
 * The 1:1 DM this client already knows with `userId`, if any. A group that
 * happens to include them is not it — a call is started in a 1:1.
 */
export function findDirectDm(userId: number): DmChannel | undefined {
  return dmStore.getState().channels.find((c) => !c.isGroup && c.recipient.id === userId);
}

/**
 * Create a DM with a user via the API and switch to it. `onReady` runs after
 * the new conversation is selected, so a caller that needs to act on it (e.g.
 * start a call, BUG-05) sees it as the active channel.
 */
export async function handleCreateDm(
  recipientId: number,
  deps: DmHelperDeps,
  onReady?: (dm: DmChannel) => void,
): Promise<void> {
  try {
    const result = await deps.api.createDm(recipientId);
    const member = membersStore.getState().members.get(recipientId);

    const recipient: DmUser = {
      id: result.recipient.id,
      username: result.recipient.username,
      avatar: result.recipient.avatar,
      status: result.recipient.status ?? member?.status ?? "offline",
      displayName: result.recipient.display_name ?? member?.displayName ?? "",
    };
    const dmChannel: DmChannel = {
      channelId: result.channel_id,
      recipient,
      participants: [recipient],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };

    addDmChannel(dmChannel);
    selectDmConversation(dmChannel, deps);
    onReady?.(dmChannel);
  } catch (err) {
    const msg = errorText(err, connectText("app.dmCreateFailed"));
    deps.getToast()?.show(msg, "error");
  }
}

// ---------------------------------------------------------------------------
// handleCreateGroupDm
// ---------------------------------------------------------------------------

/** Create a group DM with the given members and switch to it. */
export async function handleCreateGroupDm(
  recipientIds: readonly number[],
  name: string,
  deps: DmHelperDeps,
): Promise<void> {
  try {
    const result = await deps.api.createGroupDm(recipientIds, name);
    const dmChannel = dmChannelFromPayload(result);
    addDmChannel(dmChannel);
    selectDmConversation(dmChannel, deps);
  } catch (err) {
    const msg = errorText(err, connectText("app.dmCreateGroupFailed"));
    deps.getToast()?.show(msg, "error");
  }
}

// ---------------------------------------------------------------------------
// buildDmConversations — helper for DM sidebar mode
// ---------------------------------------------------------------------------

/**
 * Build a readonly DmConversation array from DM store state.
 *
 * Keyed on the channel, not on the recipient user: a group DM has no single
 * recipient, and a user can be in both a 1:1 and a group with the same person,
 * so a user id no longer identifies a row.
 */
export function buildDmConversations(activeChannelId: number | null): readonly DmConversation[] {
  const dmChannels = dmStore.getState().channels;
  return dmChannels.map((dm) => ({
    channelId: dm.channelId,
    userId: dm.recipient.id,
    username: dmDisplayName(dm),
    avatar: dm.recipient.avatar || null,
    status: (dm.recipient.status as DmConversation["status"]) ?? "offline",
    isGroup: dm.isGroup,
    participants: dm.participants.map((p) => ({
      id: p.id,
      username: (p.displayName ?? "") || p.username,
      avatar: p.avatar || null,
    })),
    lastMessage: dm.lastMessage || connectText("app.dmNoMessages"),
    timestamp: dm.lastMessageAt,
    unread: dm.unreadCount > 0 || dm.mentionCount > 0,
    unreadCount: dm.unreadCount,
    mentionCount: dm.mentionCount,
    muted: isChannelMuted(dm.channelId),
    active: dm.channelId === activeChannelId,
  }));
}
