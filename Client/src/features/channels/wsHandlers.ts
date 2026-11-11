// Channel, role, member, presence and emoji WebSocket handlers — extracted
// from lib/dispatcher.ts, which keeps every socket subscription and calls
// these plain functions.
import { authStore, setAuth } from "../../stores/auth.store";
import {
  channelsStore,
  setRoles,
  setCategories,
  setActiveChannel,
  removeChannel,
  addChannel,
  updateChannel,
  setMentionCount,
  setNsfwAcknowledged,
  noteChannelMessage,
  firstTextInSidebarOrder,
} from "../../stores/channels.store";
import {
  addMember,
  removeMember,
  updateMemberRoles,
  updateMemberProfile,
} from "../../stores/members.store";
import { updateVoiceUserProfile } from "../../stores/voice.store";
import { dmStore, updateDmParticipant } from "../../stores/dm.store";
import { setCustomEmoji } from "../../stores/emoji.store";
import { setStickers } from "../../stores/stickers.store";
import { getChannelMessages, markStickersDeleted } from "../../stores/messages.store";
import { type ChannelActivityEntry } from "../../lib/types";
import {
  acceptReadState,
  failMarkUnread,
  isChannelAway,
  isHeldUnread,
  writeReadPointer,
} from "../../lib/readState";
import { hasReceivedReady } from "../../lib/net/serverCapabilities";
import { showToast } from "../../lib/ui/toast";
import { notifyChannelActivity } from "../../lib/notifications";
import {
  loadedThreadsStore,
  threadsStoreInUse,
  withThreadsStore,
} from "../../stores/threadsLoader";
import type { Payload, WsRoute } from "../connection/dispatchContext";
import { log, route } from "../connection/dispatchContext";
import { connectText } from "../../i18n/connect";
import { WsErrorCode, ServerMessageType as S } from "@lib/protocolTypes";

import { handleGameActivityPolicy, handlePresence, handlePresenceBatch } from "./wsGameActivity";
import {
  deferMentionAlert,
  matchMentionEntry,
  threadNotifyContext,
  withdrawMentionAlert,
} from "./wsMentionAlerts";

export {
  applyReadyChannels,
  applyReadyActiveChannel,
  markReadyActiveChannelRead,
  applyReadyReadPointer,
  applyReadyEmoji,
  applyReadyStickers,
} from "./wsReadySlices";
export {
  applyReadyGameActivities,
  applyAuthOkGameActivityPolicy,
  handlePresence,
  handlePresenceBatch,
} from "./wsGameActivity";
export { MENTION_ALERT_GRACE_MS, resetChannelActivity } from "./wsMentionAlerts";

/**
 * read_state: the server moved this user's read pointer in a channel or DM and
 * says where it is now. It replaces the pointer, unread_count and mention_count
 * outright — and a channel or DM this client does not list is ignored, as is
 * anything before the first ready. The one exception to "outright" is the
 * channel the reader is watching: its badge stays at zero (as handleMentionCount
 * keeps it), because the reader is looking at it; the pointer is still stored.
 * The NEW line already in view does not move, as it follows the pointer the
 * channel was opened with.
 */
export function handleReadState(payload: Payload<"read_state">): void {
  if (!hasReceivedReady()) return;
  const id = payload.channel_id;
  const ch = channelsStore.getState().channels.get(id);
  if (ch === undefined && !dmStore.getState().channels.some((c) => c.channelId === id)) {
    // A followed thread's pointer moved (another device read it).
    if (threadsStoreInUse()) {
      withThreadsStore((m) =>
        m.applyFollowedReadState(id, {
          lastReadId: payload.last_read_message_id,
          unread: payload.unread_count,
          mentions: payload.mention_count,
        }),
      );
    }
    return;
  }
  if (!acceptReadState(id, payload.last_read_message_id)) return;
  // Not a channel just marked unread: that one keeps its counts, or the click
  // would leave no badge once the reader leaves.
  const watching =
    channelsStore.getState().activeChannelId === id && !isChannelAway(id) && !isHeldUnread(id);
  writeReadPointer(
    id,
    payload.last_read_message_id,
    watching
      ? { unread: 0, mention: 0 }
      : { unread: payload.unread_count, mention: payload.mention_count },
  );
}

/**
 * An error reply to a `mark_unread` the client sent. RATE_LIMITED and
 * NOT_FOUND say the click did nothing: tell the user, and put the pointer back
 * to where it was. Correlated by the frame id the server echoes, so an error
 * for any other frame, or for a request a new connection has replaced, is left
 * alone. Returns true when it consumed the frame.
 */
export function handleMarkUnreadError(payload: Payload<"error">, id: string | undefined): boolean {
  // Any refusal of this frame ends the request; only two have copy of their own.
  const notice =
    payload.code === WsErrorCode.RATE_LIMITED
      ? "rateLimited"
      : payload.code === WsErrorCode.NOT_FOUND
        ? "notFound"
        : "failed";
  return failMarkUnread(id, notice);
}

export function handleChannelCreate(payload: Payload<"channel_create">): void {
  addChannel(payload);
}

export function handleChannelUpdate(payload: Payload<"channel_update">): void {
  updateChannel(payload);
}

/** The manager's category list changed: replace what we hold. */
export function handleChannelCategories(payload: Payload<"channel_categories">): void {
  setCategories(payload.categories);
}

/** Another device of this account acknowledged or revoked a labelled channel. */
export function handleNsfwAck(payload: Payload<"nsfw_ack">): void {
  setNsfwAcknowledged(payload.channel_id, payload.acknowledged);
}

/**
 * A mention changed this user's badge in a channel. The server pushes
 * the reader's new total per user, raising it when a mention lands and lowering
 * it when a delete or purge reverses one; the channel is typically one this
 * client is not viewing, whose chat_message broadcast never arrives. The frame
 * is the only way such a change reaches the sidebar/taskbar badge live.
 *
 * Ignored for the active channel while the reader is present: a mention in the
 * channel on screen is already handled by its own chat_message (and, when that
 * window is detached from the live tail, counted there with the evenIfActive
 * escape hatch). Applying the server total here would paint a red badge on the
 * channel the user is reading — the badge the active-channel skip in
 * noteChannelMessage exists to prevent. While the reader is away (unfocused,
 * detached) the frame may only lower the badge, never raise it: raises still
 * come from the channel's own chat_message, so applying them would double
 * count, but a delete or purge that reverses a mention must reach the badge.
 * The frame carries an absolute total, not a delta, so a channel the reader
 * watched focused and then left would over-count mentions already seen; while
 * away, its own chat_message keeps counting live mentions. Ignored for a
 * DM-channel id too: a DM's badge lives in dmStore and its mention bump rides
 * the DM's own chat_message.
 *
 * For any other channel a raised total also fires notifyMention: nothing else
 * tells the reader, since chat_message only reaches the focused channel.
 */
export function handleMentionCount(payload: Payload<"mention_count">): void {
  const ch = channelsStore.getState().channels.get(payload.channel_id);
  if (ch === undefined) {
    if (threadsStoreInUse()) withThreadsStore((m) => handleThreadMentionCount(m, payload));
    return;
  }
  if (ch.type === "dm") return;
  if (payload.channel_id === channelsStore.getState().activeChannelId) {
    if (!isChannelAway(payload.channel_id)) return;
    setMentionCount(payload.channel_id, Math.min(ch.mentionCount, payload.count));
    return;
  }
  const previous = ch.mentionCount;
  setMentionCount(payload.channel_id, payload.count);
  // A raised total on a channel the reader is not viewing is a new mention that
  // no chat_message announced, so alert for it. A lowered or
  // unchanged total (delete, purge, repeat frame) is not a new mention. The
  // active channel never alerts here: its own chat_message already does.
  // A channel_activity entry for the mention alerts with the author and the
  // message instead, so this alert waits a moment for one.
  // A lowered total takes back the rises it reverses, pending alerts included.
  if (payload.count > previous) deferMentionAlert(payload.channel_id, payload.count - previous);
  else if (payload.count < previous)
    withdrawMentionAlert(payload.channel_id, previous - payload.count);
}

/** A followed thread's mention_count: the total repaints its row, a rise alerts like a channel's. */
function handleThreadMentionCount(
  m: NonNullable<ReturnType<typeof loadedThreadsStore>>,
  payload: Payload<"mention_count">,
): void {
  const previous = m.setFollowedMentions(payload.channel_id, payload.count);
  if (previous === undefined) return;
  if (payload.count > previous) deferMentionAlert(payload.channel_id, payload.count - previous);
  else if (payload.count < previous)
    withdrawMentionAlert(payload.channel_id, previous - payload.count);
}

/** The newest confirmed message loaded for a channel; a pending send has id 0. */
function newestLoadedId(channelId: number): number {
  const rows = getChannelMessages(channelId);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.id > 0) return rows[i]!.id;
  }
  return 0;
}

/**
 * channel_activity: new messages in readable channels the reader is
 * not viewing, so their unread dot shows without waiting for the next `ready`.
 * Each entry bumps unread through noteChannelMessage, whose id watermark keeps
 * a message `ready` already counted from counting again. The mention flags are
 * never passed as a mention: mention_count owns the badge total. The active
 * channel is skipped (its own chat_message reaches it), and so are unknown
 * channels and DM ids. A message at or below the watermark, or below the
 * newest message already loaded for the channel (one the reader just read
 * there), neither counts nor alerts.
 *
 * An entry that carries a mention alerts with its author and message, so it
 * stands in for one of that channel's mention_count rises.
 */
export function handleChannelActivity(payload: Payload<"channel_activity">): void {
  const activeId = channelsStore.getState().activeChannelId;
  for (const entry of payload.channels) {
    if (entry.channel_id === activeId) continue;
    const ch = channelsStore.getState().channels.get(entry.channel_id);
    if (ch === undefined) {
      // Not a channel: a followed thread's hint (the server sends them to
      // followers only), or a DM's, which the thread store ignores.
      if (threadsStoreInUse()) withThreadsStore((m) => handleThreadActivity(m, entry));
      continue;
    }
    if (ch.type === "dm") continue;
    if (ch.lastMessageId !== null && entry.message_id <= ch.lastMessageId) continue;
    if (entry.message_id <= newestLoadedId(entry.channel_id)) continue;
    noteChannelMessage(entry.channel_id, entry.message_id, false);
    if (entry.mentions_you || entry.mentions_everyone) matchMentionEntry(entry.channel_id);
    notifyChannelActivity(entry);
  }
}

/** A followed thread's activity entry: counted on its row, then announced as its parent would. */
function handleThreadActivity(
  m: NonNullable<ReturnType<typeof loadedThreadsStore>>,
  entry: ChannelActivityEntry,
): void {
  if (!m.noteFollowedActivity(entry.channel_id, entry.message_id)) return;
  if (entry.mentions_you || entry.mentions_everyone) matchMentionEntry(entry.channel_id);
  notifyChannelActivity(entry, threadNotifyContext(entry.channel_id));
}

export function handleChannelDelete(payload: Payload<"channel_delete">): void {
  // If the deleted channel is the active one, redirect to the first text channel.
  const activeId = channelsStore.select((s) => s.activeChannelId);
  removeChannel(payload.id);
  if (payload.id === activeId) {
    const firstText = firstTextInSidebarOrder(channelsStore.getState().channels);
    setActiveChannel(firstText?.id ?? null);
    // The redirect alone reads as the app spontaneously changing channels;
    // say why (ux/channels-members-dms §1.2).
    showToast(connectText("app.channelDeleted"), "info");
    log.info("Active channel deleted, redirected", { deletedId: payload.id });
  }
}

export function handleMemberJoin(payload: Payload<"member_join">): void {
  log.info("Member joined", { userId: payload.user.id, username: payload.user.username });
  addMember(payload);
}

export function handleMemberBan(payload: Payload<"member_ban">): void {
  log.info("Member banned", { userId: payload.user_id });
  removeMember(payload.user_id);
}

export function handleMemberUpdate(payload: Payload<"member_update">): void {
  log.info("Member role updated", { userId: payload.user_id, role: payload.role });
  applyMemberUpdates([payload]);
}

/** A role rename, delete or reorder: member_update for several members at once. */
export function handleMemberUpdateBatch(payload: Payload<"member_update_batch">): void {
  const members = payload.members ?? [];
  log.info("Member roles updated", { count: members.length });
  applyMemberUpdates(members);
}

function applyMemberUpdates(entries: readonly Payload<"member_update">[]): void {
  updateMemberRoles(entries.map((e) => ({ userId: e.user_id, role: e.role, roleIds: e.role_ids })));

  // Keep authStore in sync when the signed-in user's own role changed —
  // every permission gate (canManageChannels, canViewAuditLog, ...) reads
  // authStore.user.role, not membersStore, so without this a promotion or
  // demotion of the current user would leave every affordance stale until
  // the socket reconnects (mirrors the USER_UPDATE self-branch below).
  const me = authStore.getState().user;
  if (!me) return;
  const payload = entries.findLast((e) => e.user_id === me.id);
  if (payload !== undefined) {
    // role_ids rides along so the held-role gates follow the echo too.
    // An absent list drops the old one, as updateMemberRole does.
    const { role_ids: _old, ...withoutIds } = me;
    authStore.setState((prev) => ({
      ...prev,
      user: {
        ...withoutIds,
        role: payload.role,
        ...(payload.role_ids === undefined ? {} : { role_ids: payload.role_ids }),
      },
    }));
  }
}

// Roles changed server-side (created, edited, deleted or reordered). The
// payload is the whole list, so the store is replaced rather than patched —
// name colors, the member-list groups and every permission-gated affordance
// re-derive from it without a reconnect.
export function handleRolesUpdate(payload: Payload<"roles_update">): void {
  log.info("Roles updated", { count: payload.roles?.length ?? 0 });
  setRoles(payload.roles ?? []);
}

// Custom emoji changed server-side (uploaded or deleted). Whole set, like
// roles_update: the store is replaced so a deleted emoji stops rendering in
// messages, pickers and reaction pills without a reconnect.
export function handleEmojiUpdate(payload: Payload<"emoji_update">): void {
  log.info("Custom emoji updated", { count: payload.emoji?.length ?? 0 });
  setCustomEmoji(payload.emoji ?? []);
}

// Custom stickers changed server-side (uploaded, renamed or deleted). Whole
// set, like emoji_update: a sticker deleted while a picker is open drops out of
// its grid, and a stale id can no longer be sent from the next open.
export function handleStickerUpdate(payload: Payload<"sticker_update">): void {
  log.info("Custom stickers updated", { count: payload.stickers?.length ?? 0 });
  const stickers = payload.stickers ?? [];
  setStickers(stickers);
  // Messages already on screen still name the removed sticker: turn them into
  // "Deleted sticker" rows (never fetching the image again).
  markStickersDeleted(new Set(stickers.map((s) => s.id)));
}

export function handleUserUpdate(payload: Payload<"user_update">): void {
  log.info("User profile updated", { userId: payload.user_id, username: payload.username });
  updateMemberProfile(payload.user_id, {
    username: payload.username,
    avatar: payload.avatar,
    displayName: payload.display_name,
    identityPublicKey: payload.identity_public_key,
    about: payload.about,
    banner: payload.banner,
    banner_color: payload.banner_color,
  });
  // Same reasoning as PRESENCE above: dmStore's copy of a DM partner's
  // username/avatar/displayName is otherwise never refreshed. DmUser's
  // avatar/displayName are non-nullable ("" = unset), so null (cleared)
  // maps to "". display_name absent means "leave the nickname alone" —
  // an older or partial payload must not blank it, exactly as
  // updateMemberProfile above.
  updateDmParticipant(payload.user_id, {
    username: payload.username,
    avatar: payload.avatar ?? "",
    ...(payload.display_name === undefined ? {} : { displayName: payload.display_name ?? "" }),
  });
  // voiceStore.voiceUsers is the third store holding a frozen username
  // copy (see updateVoiceUserProfile's doc comment) — without this, a
  // rename leaves the voice roster showing the old name for the rest of
  // the call.
  updateVoiceUserProfile(payload.user_id, { username: payload.username });

  // Update auth store if the current user changed their own profile.
  const currentUser = authStore.getState().user;
  if (currentUser && payload.user_id === currentUser.id) {
    setAuth(
      authStore.getState().token ?? "",
      {
        ...currentUser,
        username: payload.username,
        avatar: payload.avatar,
        // Absent (an older or partial frame) keeps the stored value; null clears it.
        ...(payload.display_name === undefined ? {} : { display_name: payload.display_name }),
        ...(payload.about === undefined ? {} : { about: payload.about }),
        ...(payload.banner === undefined ? {} : { banner: payload.banner }),
        ...(payload.banner_color === undefined ? {} : { banner_color: payload.banner_color }),
      },
      authStore.getState().serverName ?? "",
      authStore.getState().motd ?? "",
    );
  }
}

// Channels, members, presence, emoji and the read pointer.
export const wsRoutes: readonly WsRoute[] = [
  route(S.PRESENCE, () => handlePresence),
  route(S.PRESENCE_BATCH, () => handlePresenceBatch),
  route(S.CHANNEL_CREATE, () => handleChannelCreate),
  route(S.CHANNEL_UPDATE, () => handleChannelUpdate),
  route(S.CHANNEL_CATEGORIES, () => handleChannelCategories),
  route(S.CHANNEL_DELETE, () => handleChannelDelete),
  route(S.NSFW_ACK, () => handleNsfwAck),
  route(S.MENTION_COUNT, () => handleMentionCount),
  route(S.READ_STATE, () => handleReadState),
  route(S.CHANNEL_ACTIVITY, () => handleChannelActivity),
  route(S.MEMBER_JOIN, () => handleMemberJoin),
  route(S.MEMBER_BAN, () => handleMemberBan),
  route(S.MEMBER_UPDATE, () => handleMemberUpdate),
  route(S.MEMBER_UPDATE_BATCH, () => handleMemberUpdateBatch),
  route(S.ROLES_UPDATE, () => handleRolesUpdate),
  route(S.EMOJI_UPDATE, () => handleEmojiUpdate),
  route(S.STICKER_UPDATE, () => handleStickerUpdate),
  route(S.GAME_ACTIVITY_POLICY, () => handleGameActivityPolicy),
  route(S.USER_UPDATE, () => handleUserUpdate),
];
