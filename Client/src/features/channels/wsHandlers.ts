// Channel, role, member, presence and emoji WebSocket handlers — extracted
// from lib/dispatcher.ts, which keeps every socket subscription and calls
// these plain functions.
import { authStore, setAuth, updateUser } from "../../stores/auth.store";
import {
  channelsStore,
  setChannels,
  setRoles,
  setActiveChannel,
  removeChannel,
  addChannel,
  updateChannel,
} from "../../stores/channels.store";
import {
  setMembers,
  addMember,
  removeMember,
  updateMemberRole,
  updateMemberProfile,
  updatePresence,
} from "../../stores/members.store";
import { updateVoiceUserProfile } from "../../stores/voice.store";
import { updateDmParticipant } from "../../stores/dm.store";
import { emojiStore, setCustomEmoji } from "../../stores/emoji.store";
import { uiStore } from "../../stores/ui.store";
import { isTextLikeChannel } from "../../lib/types";
import { markChannelRead } from "../../lib/read-state";
import { showToast } from "../../lib/toast";
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";

/** The channel/role/member snapshot of `ready`. */
export function applyReadyChannels(payload: Payload<"ready">): void {
  setChannels(payload.channels);
  setRoles(payload.roles ?? []);
  setMembers(payload.members);
}

/**
 * The active-channel slice of `ready`: auto-select, or clear a channel that is
 * gone. Returns the channel markReadyActiveChannelRead should mark read.
 */
export function applyReadyActiveChannel(payload: Payload<"ready">): number | null {
  // Auto-select the first text channel if none is active; clear it when
  // the channel this session was viewing is gone from the fresh snapshot
  // (deleted, or a DM closed elsewhere while this client was offline) so
  // the activeChannelId subscriber actually fires and tears down the
  // stale message list/composer instead of leaving them mounted against
  // a channel the server no longer recognizes. Checked against the raw
  // payload (not the synthesized channelsStore row) so a still-open DM
  // that was never locally synthesized this session isn't wrongly
  // cleared.
  const currentActive = channelsStore.select((s) => s.activeChannelId);
  // Set only when the branch below clears a channel that was active
  // before this ready — distinct from "no channel was active", which
  // must NOT mark-read whatever the auto-select branch just picked.
  let activeChannelCleared = false;
  // A content view (B9-4) leaves no channel active on purpose; auto-selecting
  // one would close it.
  const viewOpen = uiStore.getState().activeView !== null;
  if (currentActive === null && !viewOpen && payload.channels.length > 0) {
    const firstText = payload.channels.find((ch) => isTextLikeChannel(ch));
    if (firstText !== undefined) {
      setActiveChannel(firstText.id);
    }
  } else if (currentActive !== null) {
    const stillPresent =
      payload.channels.some((ch) => ch.id === currentActive) ||
      (payload.dm_channels ?? []).some((dm) => dm.channel_id === currentActive);
    if (!stillPresent) {
      setActiveChannel(null);
      activeChannelCleared = true;
    }
  }
  return activeChannelCleared ? null : currentActive;
}

/** Mark the channel the user was already reading as read after `ready`. */
export function markReadyActiveChannelRead(currentActive: number | null): void {
  // The server's read_states go stale while a channel stays focused
  // (channel_focus is sent once per mount, mark_read only from the context
  // menu), so a full-ready resync restates non-zero unread/mention counts
  // for the very channel the user is reading. Mark it read: this advances
  // the server read state and clears the local badges, for server channels
  // and DMs alike. Skipped on first connect (nothing was active yet) and
  // when applyReadyActiveChannel just cleared a channel that's gone — it
  // returns null for both.
  if (currentActive !== null) {
    markChannelRead(currentActive);
  }
}

/** The custom-emoji slice of `ready`. */
export function applyReadyEmoji(api: DispatchApi | undefined): void {
  // Custom emoji are not in the ready payload (they are server-wide and
  // change rarely, so they do not belong in the per-session dump). Load
  // them once here; `emoji_update` keeps them fresh from then on. A
  // failure is non-fatal — unresolved shortcodes stay plain text.
  //
  // OC-0251: snapshot the revision emojiStore was at right before issuing
  // this fetch, mirroring the OC-0218 blockedByMeRev guard above. The GET
  // travels over a separate HTTP connection while an `emoji_update` can
  // arrive on the already-open socket — if one lands (bumping the
  // revision) while this GET is in flight, setCustomEmoji sees the
  // mismatch and skips applying this reply instead of clobbering the
  // fresher broadcast with a stale full-set snapshot.
  if (api?.listEmoji !== undefined) {
    const emojiRevAtFetch = emojiStore.getState().rev ?? 0;
    api
      .listEmoji()
      .then((list) => setCustomEmoji(list, emojiRevAtFetch))
      .catch((err) => log.warn("Failed to load custom emoji", { error: String(err) }));
  }
}

export function handlePresence(payload: Payload<"presence">): void {
  // custom_status is passed through verbatim, undefined included: the
  // store treats "field absent" as "leave the text alone", which is what
  // an older server's presence event means.
  updatePresence(payload.user_id, payload.status, payload.custom_status);
  // dmStore keeps its own frozen copy of a DM partner's status for the
  // sidebar row (see buildDmConversations) — membersStore alone does not
  // reach it.
  updateDmParticipant(payload.user_id, { status: payload.status });
}

export function handleChannelCreate(payload: Payload<"channel_create">): void {
  addChannel(payload);
}

export function handleChannelUpdate(payload: Payload<"channel_update">): void {
  updateChannel(payload);
}

export function handleChannelDelete(payload: Payload<"channel_delete">): void {
  // If the deleted channel is the active one, redirect to the first text channel.
  const activeId = channelsStore.select((s) => s.activeChannelId);
  removeChannel(payload.id);
  if (payload.id === activeId) {
    const remaining = channelsStore.select((s) => s.channels);
    const sorted = [...remaining.values()]
      .filter((ch) => isTextLikeChannel(ch))
      .toSorted((a, b) => a.position - b.position);
    const firstTextId = sorted.length > 0 ? sorted[0]!.id : null;
    setActiveChannel(firstTextId);
    // The redirect alone reads as the app spontaneously changing channels;
    // say why (ux/channels-members-dms §1.2).
    showToast("This channel was deleted", "info");
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
  updateMemberRole(payload.user_id, payload.role);

  // Keep authStore in sync when the signed-in user's own role changed —
  // every permission gate (canManageChannels, canViewAuditLog, ...) reads
  // authStore.user.role, not membersStore, so without this a promotion or
  // demotion of the current user would leave every affordance stale until
  // the socket reconnects (mirrors the USER_UPDATE self-branch below).
  const me = authStore.getState().user;
  if (me && payload.user_id === me.id) {
    updateUser({ role: payload.role });
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

export function handleUserUpdate(payload: Payload<"user_update">): void {
  log.info("User profile updated", { userId: payload.user_id, username: payload.username });
  updateMemberProfile(payload.user_id, {
    username: payload.username,
    avatar: payload.avatar,
    displayName: payload.display_name,
    identityPublicKey: payload.identity_public_key,
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
        display_name: payload.display_name,
        about: payload.about,
      },
      authStore.getState().serverName ?? "",
      authStore.getState().motd ?? "",
    );
  }
}
