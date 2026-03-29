/**
 * Voice store — holds voice channel state, local audio controls, and per-user voice info.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
} from "@lib/types";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";

export interface VoiceUser {
  readonly userId: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface VoiceConfig {
  readonly quality: string;
  readonly bitrate: number;
  readonly threshold_mode: string;
  readonly mixing_threshold: number;
  readonly top_speakers: number;
  readonly max_users: number;
}

export interface VoiceState {
  readonly currentChannelId: number | null;
  readonly voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>; // channelId -> userId -> VoiceUser
  readonly voiceConfigs: ReadonlyMap<number, VoiceConfig>; // channelId -> VoiceConfig
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
  readonly localCamera: boolean;
  readonly localScreenshare: boolean;
  /** Epoch ms when the local user joined the current voice channel (for elapsed timer). */
  readonly joinedAt: number | null;
  /** True when joined in listen-only mode (mic permission denied or no mic found). */
  readonly listenOnly: boolean;
}

const INITIAL_STATE: VoiceState = {
  currentChannelId: null,
  voiceUsers: new Map(),
  voiceConfigs: new Map(),
  localMuted: false,
  localDeafened: false,
  localCamera: false,
  localScreenshare: false,
  joinedAt: null,
  listenOnly: false,
};

export const voiceStore = createStore<VoiceState>(INITIAL_STATE);

/** Reset voice store to initial state (e.g. on logout). */
export function resetVoiceStore(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
  }));
}

/** Bulk set voice states from the ready payload. */
export function setVoiceStates(states: readonly ReadyVoiceState[]): void {
  const channelMap = new Map<number, Map<number, VoiceUser>>();

  for (const vs of states) {
    let userMap = channelMap.get(vs.channel_id);
    if (!userMap) {
      userMap = new Map();
      channelMap.set(vs.channel_id, userMap);
    }
    const member = membersStore.getState().members.get(vs.user_id);
    userMap.set(vs.user_id, {
      userId: vs.user_id,
      username: member?.username ?? "",
      muted: vs.muted,
      deafened: vs.deafened,
      speaking: false,
      camera: false,
      screenshare: false,
    });
  }

  // Check if current user is in any voice channel
  const currentUserId = authStore.getState().user?.id ?? 0;
  let autoJoinChannel: number | null = null;
  if (currentUserId !== 0) {
    for (const vs of states) {
      if (vs.user_id === currentUserId) {
        autoJoinChannel = vs.channel_id;
        break;
      }
    }
  }

  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: channelMap,
    // If user is in a voice channel per ready payload, use that channel.
    // Otherwise preserve prev — user may be mid-join and server hasn't
    // registered them yet. Stale IDs are cleared by leaveVoiceChannel()
    // or resetVoiceStore() on logout.
    currentChannelId: autoJoinChannel ?? prev.currentChannelId,
  }));
}

/** Update or add a user's voice state from a voice_state event. */
export function updateVoiceState(payload: VoiceStatePayload): void {
  voiceStore.setState((prev) => {
    const nextChannels = new Map(prev.voiceUsers);
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    const nextUsers = new Map(existingChannel ?? []);

    nextUsers.set(payload.user_id, {
      userId: payload.user_id,
      username: payload.username,
      muted: payload.muted,
      deafened: payload.deafened,
      speaking: payload.speaking,
      camera: payload.camera,
      screenshare: payload.screenshare,
    });

    nextChannels.set(payload.channel_id, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Remove a user from a voice channel. */
export function removeVoiceUser(payload: VoiceLeavePayload): void {
  voiceStore.setState((prev) => {
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    if (!existingChannel || !existingChannel.has(payload.user_id)) return prev;

    const nextChannels = new Map(prev.voiceUsers);
    const nextUsers = new Map(existingChannel);
    nextUsers.delete(payload.user_id);

    if (nextUsers.size === 0) {
      nextChannels.delete(payload.channel_id);
    } else {
      nextChannels.set(payload.channel_id, nextUsers);
    }

    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Set the current voice channel (local join) and record the join timestamp.
 *  Only resets joinedAt if the user is joining a different channel (or was not in one). */
export function joinVoiceChannel(channelId: number): void {
  voiceStore.setState((prev) => {
    // Already in this channel — don't reset the timer
    if (prev.currentChannelId === channelId) return prev;
    return {
      ...prev,
      currentChannelId: channelId,
      joinedAt: Date.now(),
    };
  });
}

/** Clear the current voice channel and remove current user from voice users. */
export function leaveVoiceChannel(): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  voiceStore.setState((prev) => {
    const channelId = prev.currentChannelId;
    if (channelId === null || currentUserId === 0) {
      return { ...prev, currentChannelId: null, joinedAt: null };
    }
    const existingChannel = prev.voiceUsers.get(channelId);
    if (!existingChannel || !existingChannel.has(currentUserId)) {
      return { ...prev, currentChannelId: null, joinedAt: null };
    }
    const nextChannels = new Map(prev.voiceUsers);
    const nextUsers = new Map(existingChannel);
    nextUsers.delete(currentUserId);
    if (nextUsers.size === 0) {
      nextChannels.delete(channelId);
    } else {
      nextChannels.set(channelId, nextUsers);
    }
    return { ...prev, currentChannelId: null, joinedAt: null, voiceUsers: nextChannels };
  });
}

/** Toggle local mute state. */
export function setLocalMuted(muted: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localMuted: muted,
  }));
}

/** Toggle local deafen state. */
export function setLocalDeafened(deafened: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localDeafened: deafened,
  }));
}

/** Toggle local camera state. */
export function setLocalCamera(enabled: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localCamera: enabled,
  }));
}

/** Toggle local screenshare state. */
export function setLocalScreenshare(enabled: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localScreenshare: enabled,
  }));
}

/** Set listen-only mode (mic permission denied or no mic found). */
export function setListenOnly(listenOnly: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    listenOnly,
  }));
}

/** Update the current user's speaking state for local VAD feedback. */
export function setLocalSpeaking(speaking: boolean): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  if (currentUserId === 0) return;
  voiceStore.setState((prev) => {
    const channelId = prev.currentChannelId;
    if (channelId === null) return prev;
    const channelUsers = prev.voiceUsers.get(channelId);
    if (!channelUsers) return prev;
    const user = channelUsers.get(currentUserId);
    if (!user || user.speaking === speaking) return prev;
    const nextUsers = new Map(channelUsers);
    nextUsers.set(currentUserId, { ...user, speaking });
    const nextChannels = new Map(prev.voiceUsers);
    nextChannels.set(channelId, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Store voice config for a channel from a voice_config event. */
export function setVoiceConfig(payload: VoiceConfigPayload): void {
  voiceStore.setState((prev) => {
    const nextConfigs = new Map(prev.voiceConfigs);
    nextConfigs.set(payload.channel_id, {
      quality: payload.quality,
      bitrate: payload.bitrate,
      threshold_mode: payload.threshold_mode,
      mixing_threshold: payload.mixing_threshold,
      top_speakers: payload.top_speakers,
      max_users: payload.max_users,
    });
    return { ...prev, voiceConfigs: nextConfigs };
  });
}

/** Update speaking state for users from a voice_speakers event or
 *  LiveKit's ActiveSpeakersChanged. Updates ALL users including local
 *  (LiveKit is now the sole authority for speaking detection). */
export function setSpeakers(payload: VoiceSpeakersPayload): void {
  voiceStore.setState((prev) => {
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    if (!existingChannel) return prev;

    const speakerSet = new Set(payload.speakers);
    const nextUsers = new Map<number, VoiceUser>();

    for (const [userId, user] of existingChannel) {
      const isSpeaking = speakerSet.has(userId);
      if (user.speaking !== isSpeaking) {
        nextUsers.set(userId, { ...user, speaking: isSpeaking });
      } else {
        nextUsers.set(userId, user);
      }
    }

    const nextChannels = new Map(prev.voiceUsers);
    nextChannels.set(payload.channel_id, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Selector: get all voice users in a specific channel. */
export function getChannelVoiceUsers(channelId: number): readonly VoiceUser[] {
  return voiceStore.select((s) => {
    const channelUsers = s.voiceUsers.get(channelId);
    if (!channelUsers) return [];
    return Array.from(channelUsers.values());
  });
}
