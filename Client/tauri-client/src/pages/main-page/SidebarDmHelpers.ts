/**
 * SidebarDmHelpers — DM-related business logic helpers used by both the
 * embedded DM section (channels mode) and the full DM sidebar (dms mode).
 */

import type { ApiClient } from "@lib/api";
import type { ToastContainer } from "@components/Toast";
import type { DmConversation } from "@components/DmSidebar";
import { setSidebarMode, setActiveDmUser } from "@stores/ui.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import { dmStore, clearDmUnread, addDmChannel } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";

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
export function selectDmConversation(
  dmChannel: DmChannel,
  deps: DmHelperDeps,
): void {
  // Save current channel so we can restore it when user clicks "Back"
  // Only save if the current channel is a real text/voice channel, not another DM
  const currentActive = channelsStore.getState().activeChannelId;
  if (currentActive !== null) {
    const currentCh = channelsStore.getState().channels.get(currentActive);
    if (currentCh !== undefined && currentCh.type !== "dm") {
      deps.setChannelBeforeDm(currentActive);
    }
  }

  setActiveDmUser(dmChannel.recipient.id);
  setSidebarMode("dms");
  clearDmUnread(dmChannel.channelId);

  // Add the DM channel to channelsStore so ChannelController can load it
  addDmToChannelsStore(dmChannel);
  setActiveChannel(dmChannel.channelId);
}

// ---------------------------------------------------------------------------
// addDmToChannelsStore
// ---------------------------------------------------------------------------

/** Ensure a DM channel exists in channelsStore so ChannelController can switch to it. */
export function addDmToChannelsStore(dmChannel: DmChannel): void {
  const existing = channelsStore.getState().channels.get(dmChannel.channelId);

  // If the channel exists but has an empty name (server sends DMs with name=''),
  // update it with the recipient's username
  if (existing !== undefined && existing.name !== "") return;

  const newChannel: Channel = {
    id: dmChannel.channelId,
    name: dmChannel.recipient.username,
    type: "dm",
    category: null,
    position: 0,
    unreadCount: dmChannel.unreadCount,
    lastMessageId: dmChannel.lastMessageId,
  };
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.set(newChannel.id, newChannel);
    return { ...prev, channels: next };
  });
}

// ---------------------------------------------------------------------------
// handleCreateDm
// ---------------------------------------------------------------------------

/** Create a DM with a user via the API and switch to it. */
export async function handleCreateDm(
  recipientId: number,
  deps: DmHelperDeps,
): Promise<void> {
  try {
    const result = await deps.api.createDm(recipientId);
    const member = membersStore.getState().members.get(recipientId);

    const dmChannel: DmChannel = {
      channelId: result.channel_id,
      recipient: {
        id: result.recipient.id,
        username: result.recipient.username,
        avatar: result.recipient.avatar,
        status: result.recipient.status ?? member?.status ?? "offline",
      },
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
    };

    addDmChannel(dmChannel);
    selectDmConversation(dmChannel, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create DM";
    deps.getToast()?.show(msg, "error");
  }
}

// ---------------------------------------------------------------------------
// buildDmConversations — helper for DM sidebar mode
// ---------------------------------------------------------------------------

/** Build a readonly DmConversation array from DM store state. */
export function buildDmConversations(activeDmUserId: number | null): readonly DmConversation[] {
  const dmChannels = dmStore.getState().channels;
  return dmChannels.map((dm) => ({
    userId: dm.recipient.id,
    username: dm.recipient.username,
    avatar: dm.recipient.avatar || null,
    status: (dm.recipient.status as DmConversation["status"]) ?? "offline",
    lastMessage: dm.lastMessage || "No messages yet",
    timestamp: dm.lastMessageAt,
    unread: dm.unreadCount > 0,
    active: dm.recipient.id === activeDmUserId,
  }));
}
