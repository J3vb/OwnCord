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
import { dmStore, clearDmUnread, addDmChannel, dmDisplayName } from "@stores/dm.store";
import type { DmChannel, DmUser } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { isChannelMuted } from "@lib/channel-mutes";
import type { DmChannelPayload } from "@lib/types";

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
// addDmToChannelsStore
// ---------------------------------------------------------------------------

/** Ensure a DM channel exists in channelsStore so ChannelController can switch to it. */
export function addDmToChannelsStore(dmChannel: DmChannel): void {
  const existing = channelsStore.getState().channels.get(dmChannel.channelId);

  // Re-synthesise when the stored name has gone stale as well as when it is
  // empty: a group rename or a member leaving changes what the DM is called,
  // and the channels-store copy is what the chat header reads.
  if (existing !== undefined && existing.name === dmDisplayName(dmChannel)) return;

  const newChannel: Channel = {
    id: dmChannel.channelId,
    name: dmDisplayName(dmChannel),
    type: "dm",
    category: null,
    position: 0,
    unreadCount: dmChannel.unreadCount,
    // The DM's own mention count, not a hardcoded 0: the ready payload now
    // carries it, so a DM mention badge survives a reconnect.
    mentionCount: dmChannel.mentionCount,
    lastMessageId: dmChannel.lastMessageId,
    // Channel-level permission is always true for DMs; block state is layered on
    // top by the composer via blocks.store (see ChannelController), not canSend.
    canSend: true,
    slowMode: 0,
    topic: "",
    // A DM is never age-gated and has no voice capacity: the flags exist on
    // guild channels, and a DM row is synthesised here rather than coming from
    // the server's channel list.
    nsfw: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
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
export async function handleCreateDm(recipientId: number, deps: DmHelperDeps): Promise<void> {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create DM";
    deps.getToast()?.show(msg, "error");
  }
}

// ---------------------------------------------------------------------------
// dmChannelFromPayload
// ---------------------------------------------------------------------------

/**
 * Map a server DM summary (the shape `POST /dms/group`, `PATCH /dms/{id}`,
 * `GET /dms` and `dm_channel_open` all share) into the store's DmChannel.
 *
 * The dispatcher has its own copy of this for the WS path; this one exists so
 * the REST responses land in exactly the same shape without importing the
 * dispatcher's internals into the sidebar.
 */
export function dmChannelFromPayload(p: DmChannelPayload): DmChannel {
  const participants: DmUser[] = (p.recipients ?? [p.recipient]).map((u) => ({
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    status: u.status,
    displayName: u.display_name ?? "",
  }));
  return {
    channelId: p.channel_id,
    recipient: participants[0] ?? {
      id: p.recipient.id,
      username: p.recipient.username,
      avatar: p.recipient.avatar,
      status: p.recipient.status,
      displayName: p.recipient.display_name ?? "",
    },
    participants,
    name: p.name ?? "",
    isGroup: p.is_group ?? false,
    lastMessageId: p.last_message_id,
    lastMessage: p.last_message,
    lastMessageAt: p.last_message_at,
    unreadCount: p.unread_count,
    mentionCount: p.mention_count ?? 0,
  };
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
    const msg = err instanceof Error ? err.message : "Failed to create group DM";
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
    lastMessage: dm.lastMessage || "No messages yet",
    timestamp: dm.lastMessageAt,
    unread: dm.unreadCount > 0 || dm.mentionCount > 0,
    unreadCount: dm.unreadCount,
    mentionCount: dm.mentionCount,
    muted: isChannelMuted(dm.channelId),
    active: dm.channelId === activeChannelId,
  }));
}
