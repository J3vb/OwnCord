/**
 * The channel sidebar's inputs: the one `select` over its stores and
 * preferences, the projection of their states into what the rows draw, and
 * the equality that decides whether a change reaches a render.
 */

import { eventSource, select, type Selection } from "@lib/ui/select";
import { USER_LOCAL_MUTE_CHANGED } from "@lib/constants";
import { CHANNEL_MUTE_CHANGED } from "@lib/prefs/channelMutes";
import { isHideMutedChannels } from "@lib/prefs/hideMutedChannels";
import { PREF_CHANGE_EVENT } from "@lib/prefs/preferences";
import { authStore, type AuthState } from "@stores/auth.store";
import { channelsStore, type ChannelsState } from "@stores/channels.store";
import { followedThreadsStore, type FollowedThreadsView } from "@stores/followedThreads.store";
import { membersStore, type Member, type MembersState } from "@stores/members.store";
import { uiStore, type UiState } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import type { PeerVerification, VoiceState } from "@stores/voice.store";
import { safetyStore, type SafetyState } from "../safety/store";
import type { ChannelListInputs } from "./channelRowModel";
import type { VoiceRowInputs } from "./voiceRowModel";

/** A peer verification map for a voice state that has none yet: one shared
 *  instance, so an absent map compares equal across projections. */
const NO_VERIFICATIONS: ReadonlyMap<number, PeerVerification> = new Map();

/**
 * The voice rows' inputs from the states the sidebar's `select` hands it.
 * Reads only its arguments; the optional voice fields an older
 * state lacks are defaulted here, as the row builders expect.
 */
function projectVoiceInputs(
  voice: VoiceState,
  members: MembersState,
  auth: AuthState,
  channels: ChannelsState,
  ui: UiState,
  safety: SafetyState,
  localMute: object,
): VoiceRowInputs {
  const voiceMembers = new Map<number, Member>();
  for (const users of voice.voiceUsers.values()) {
    for (const uid of users.keys()) {
      const member = members.members.get(uid);
      if (member !== undefined) voiceMembers.set(uid, member);
    }
  }
  const movable: number[] = [];
  for (const ch of channels.channels.values()) {
    if (ch.type === "voice" && ch.canMoveVoice === true) {
      movable.push(ch.id);
    }
  }
  return {
    voiceUsers: voice.voiceUsers,
    currentChannelId: voice.currentChannelId,
    peerVerifications: voice.peerVerifications ?? NO_VERIFICATIONS,
    localSessionFingerprint: voice.localSessionFingerprint ?? null,
    localSafetyNumber: voice.localSafetyNumber ?? null,
    voiceMembers,
    selfId: auth.user?.id ?? null,
    connectionStatus: ui.connectionStatus,
    timeout: safety.timeout,
    movable: movable.toSorted((a, b) => a - b),
    localMute,
    ...(voice.musicSharers === undefined ? {} : { musicSharers: voice.musicSharers }),
  };
}

/** `===` per field, except the two the projection builds fresh: the members
 *  in voice (equal when every entry is the same object, so presence churn of
 *  anyone else never reaches the voice rows) and the movable ids. */
export function sameVoiceInputs(a: VoiceRowInputs, b: VoiceRowInputs): boolean {
  if (
    a.voiceUsers !== b.voiceUsers ||
    a.currentChannelId !== b.currentChannelId ||
    a.peerVerifications !== b.peerVerifications ||
    a.localSessionFingerprint !== b.localSessionFingerprint ||
    a.localSafetyNumber !== b.localSafetyNumber ||
    a.selfId !== b.selfId ||
    a.connectionStatus !== b.connectionStatus ||
    a.timeout !== b.timeout ||
    a.localMute !== b.localMute ||
    a.musicSharers !== b.musicSharers
  ) {
    return false;
  }
  if (a.voiceMembers.size !== b.voiceMembers.size) return false;
  for (const [uid, member] of a.voiceMembers) {
    if (b.voiceMembers.get(uid) !== member) return false;
  }
  return a.movable.length === b.movable.length && a.movable.every((id, i) => b.movable[i] === id);
}

/** The voice channels with at least one participant, as one comparable key. */
export function occupiedKey(inputs: VoiceRowInputs): string {
  const ids: number[] = [];
  for (const [channelId, users] of inputs.voiceUsers) {
    if (users.size > 0) ids.push(channelId);
  }
  return ids.toSorted((a, b) => a - b).join(",");
}

/** Everything the sidebar draws, from one `select`: the voice rows'
 *  inputs, the channel list's, and the header's server name. */
export interface SidebarInputs {
  readonly voice: VoiceRowInputs;
  readonly list: ChannelListInputs;
  readonly serverName: string | null;
}

/**
 * The sidebar's inputs from the states its `select` hands it. Reads only its
 * arguments. `mute` is a fresh token per mute event and `hideMuted` the
 * preference's current value, so a change to either is a change to `list`.
 */
function projectSidebarInputs(
  voice: VoiceState,
  members: MembersState,
  auth: AuthState,
  channels: ChannelsState,
  ui: UiState,
  safety: SafetyState,
  localMute: object,
  mute: object,
  hideMuted: boolean,
  followed: FollowedThreadsView,
): SidebarInputs {
  return {
    voice: projectVoiceInputs(voice, members, auth, channels, ui, safety, localMute),
    list: {
      channels: channels.channels,
      activeChannelId: channels.activeChannelId,
      selfRole: auth.user?.role ?? "",
      selfRoleIds: auth.user?.role_ids,
      roles: channels.roles,
      categories: channels.categories,
      collapsed: ui.collapsedCategories,
      hideMuted,
      mute,
      threads: followed.byParent,
      focusedThreadId: followed.focusedId,
    },
    serverName: auth.serverName,
  };
}

/** `===` on every list field. */
export function sameListInputs(a: ChannelListInputs, b: ChannelListInputs): boolean {
  return (
    a.channels === b.channels &&
    a.activeChannelId === b.activeChannelId &&
    a.selfRole === b.selfRole &&
    a.selfRoleIds === b.selfRoleIds &&
    a.roles === b.roles &&
    a.categories === b.categories &&
    a.collapsed === b.collapsed &&
    a.hideMuted === b.hideMuted &&
    a.mute === b.mute &&
    a.threads === b.threads &&
    a.focusedThreadId === b.focusedThreadId
  );
}

/** `sameVoiceInputs` for the voice part, `===` on every list field and on the
 *  server name. */
function sameSidebarInputs(a: SidebarInputs, b: SidebarInputs): boolean {
  return (
    sameVoiceInputs(a.voice, b.voice) &&
    sameListInputs(a.list, b.list) &&
    a.serverName === b.serverName
  );
}

/**
 * The sidebar's one selection over its sources, owned by `signal`. Created
 * before the header and the first render, which read it (onChange cannot fire
 * synchronously).
 *
 * Rows take channelAccess(list) from these inputs (and canModerateVoice()
 * is read only when the voice menu opens). The role and the roles are
 * sources, so a self MEMBER_UPDATE or a ROLES_UPDATE alone redraws the
 * category "+", the channel menu and the voice-moderation menu; nothing
 * can read them unsubscribed.
 */
export function selectSidebarInputs(
  signal: AbortSignal,
  onChange: (next: SidebarInputs, prev: SidebarInputs) => void,
): Selection<SidebarInputs> {
  // A fresh token per event: localSilenced answers may differ after it.
  const localMuteSource = eventSource(USER_LOCAL_MUTE_CHANGED, () => ({}));
  // The event is dispatched on window by the mute store, so every writer
  // (context menu, Settings unmute) redraws the rows (F16). A fresh token per
  // event; the mute list itself is read live through `listCtx.isMuted`.
  const muteSource = eventSource(CHANNEL_MUTE_CHANGED, () => ({}));
  // The Hide Muted Channels preference; any other key reruns the projection
  // and compares equal.
  const hideMutedSource = eventSource(PREF_CHANGE_EVENT, isHideMutedChannels);
  return select(
    [
      voiceStore,
      membersStore,
      authStore,
      channelsStore,
      uiStore,
      safetyStore,
      localMuteSource,
      muteSource,
      hideMutedSource,
      followedThreadsStore,
    ],
    projectSidebarInputs,
    onChange,
    { signal, equals: sameSidebarInputs },
  );
}
