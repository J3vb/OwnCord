/**
 * Voice store — holds voice channel state, local audio controls, and per-user voice info.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
} from "@lib/types";

export interface VoiceUser {
  readonly userId: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface VoiceState {
  readonly currentChannelId: number | null;
  readonly voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>; // channelId -> userId -> VoiceUser
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
}

const INITIAL_STATE: VoiceState = {
  currentChannelId: null,
  voiceUsers: new Map(),
  localMuted: false,
  localDeafened: false,
};

export const voiceStore = createStore<VoiceState>(INITIAL_STATE);

/** Bulk set voice states from the ready payload. */
export function setVoiceStates(states: readonly ReadyVoiceState[]): void {
  const channelMap = new Map<number, Map<number, VoiceUser>>();

  for (const vs of states) {
    let userMap = channelMap.get(vs.channel_id);
    if (!userMap) {
      userMap = new Map();
      channelMap.set(vs.channel_id, userMap);
    }
    userMap.set(vs.user_id, {
      userId: vs.user_id,
      username: "",
      muted: vs.muted,
      deafened: vs.deafened,
      speaking: false,
      camera: false,
      screenshare: false,
    });
  }

  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: channelMap,
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

/** Set the current voice channel (local join). */
export function joinVoiceChannel(channelId: number): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: channelId,
  }));
}

/** Clear the current voice channel (local leave). */
export function leaveVoiceChannel(): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: null,
  }));
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

/** Selector: get all voice users in a specific channel. */
export function getChannelVoiceUsers(channelId: number): readonly VoiceUser[] {
  return voiceStore.select((s) => {
    const channelUsers = s.voiceUsers.get(channelId);
    if (!channelUsers) return [];
    return Array.from(channelUsers.values());
  });
}
