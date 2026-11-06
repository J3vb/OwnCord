/**
 * Pure helpers for what peers report about themselves (decode lists, key
 * slots, bound offers, who watches whose screen share) and for the frames
 * that re-tell the server our own mute and deafen. No store access;
 * voice.store.ts is the facade that runs them inside setState.
 */

import type { ClientMessage, VoiceConfigPayload } from "@lib/types";
import type { PeerVerification, VoiceState } from "./voiceModel";

export function withPeerVideoDecode(
  prev: VoiceState,
  userId: number,
  list: readonly string[] | undefined,
): VoiceState {
  const current = prev.peerVideoDecode;
  if (list === undefined) {
    if (!current?.has(userId)) return prev;
    const next = new Map(current);
    next.delete(userId);
    return { ...prev, peerVideoDecode: next };
  }
  const next = new Map(current);
  next.set(userId, [...list]);
  return { ...prev, peerVideoDecode: next };
}

export function withPeerKeySlots(prev: VoiceState, userId: number, keySlots: boolean): VoiceState {
  const current = prev.peerKeySlots;
  if ((current?.has(userId) ?? false) === keySlots) return prev;
  const next = new Set(current);
  if (keySlots) next.add(userId);
  else next.delete(userId);
  return { ...prev, peerKeySlots: next };
}

export function withPeerBoundOffers(
  prev: VoiceState,
  userId: number,
  boundOffers: boolean,
): VoiceState {
  const current = prev.peerBoundOffers;
  if ((current?.has(userId) ?? false) === boundOffers) return prev;
  const next = new Set(current);
  if (boundOffers) next.add(userId);
  else next.delete(userId);
  return { ...prev, peerBoundOffers: next };
}

/** A frame for a user who is not in the current channel's roster is ignored;
 *  an empty list clears the entry. */
export function withPeerWatching(
  prev: VoiceState,
  userId: number,
  watching: readonly number[],
): VoiceState {
  const channelId = prev.currentChannelId;
  if (channelId === null || prev.voiceUsers.get(channelId)?.has(userId) !== true) return prev;
  const current = prev.peerWatching;
  const had = current?.get(userId);
  if (watching.length === 0) {
    if (had === undefined) return prev;
    const next = new Map(current);
    next.delete(userId);
    return { ...prev, peerWatching: next };
  }
  if (had !== undefined && had.length === watching.length && had.every((v, i) => v === watching[i]))
    return prev;
  const next = new Map(current);
  next.set(userId, [...watching]);
  return { ...prev, peerWatching: next };
}

/** The channel members who watch a sharer's screen, as sorted user ids: the
 *  members whose set has the sharer, plus `selfId` when it watches locally,
 *  never the sharer. Empty unless the sharer's voice user has screenshare on. */
export function viewersOfShare(
  state: VoiceState,
  sharerId: number,
  watchingLocally: boolean,
  selfId: number,
): number[] {
  const channelId = state.currentChannelId;
  if (channelId === null) return [];
  const members = state.voiceUsers.get(channelId);
  if (members?.get(sharerId)?.screenshare !== true) return [];
  const out: number[] = [];
  for (const id of members.keys()) {
    if (id === sharerId) continue;
    if (id === selfId ? watchingLocally : state.peerWatching?.get(id)?.includes(sharerId) === true)
      out.push(id);
  }
  return out.toSorted((a, b) => a - b);
}

type SelfVoiceFrame = Extract<ClientMessage, { type: "voice_mute" | "voice_deafen" }>;

/** A moderator's mute or deafen is not the member's own state to restate:
 *  sending it would turn it into a self-mute that outlives the lift. */
function isModerated(state: VoiceState): boolean {
  return state.localServerDeafened === true || state.moderatorDeafened === true;
}

function muteFrame(state: VoiceState, rowMuted: boolean): SelfVoiceFrame | null {
  if (isModerated(state) || state.localServerMuted === true) return null;
  if (state.localMuted === rowMuted) return null;
  return { type: "voice_mute", payload: { muted: state.localMuted } };
}

function deafenFrame(state: VoiceState, rowDeafened: boolean): SelfVoiceFrame | null {
  if (isModerated(state) || state.localDeafened === rowDeafened) return null;
  return { type: "voice_deafen", payload: { deafened: state.localDeafened } };
}

/** The frames that bring the server's row for `userId` in line with the local
 *  mute and deafen, mute first. Nothing outside a channel or when signed out.
 *  skipMute/skipDeafen: the caller knows that state is a moderator's. */
export function selfVoiceFrames(
  state: VoiceState,
  userId: number,
  skipMute: boolean,
  skipDeafen: boolean,
): SelfVoiceFrame[] {
  if (state.currentChannelId === null || userId === 0) return [];
  const row = state.voiceUsers.get(state.currentChannelId)?.get(userId);
  const frames = [
    skipMute ? null : muteFrame(state, row?.muted ?? false),
    skipDeafen ? null : deafenFrame(state, row?.deafened ?? false),
  ];
  return frames.filter((frame): frame is SelfVoiceFrame => frame !== null);
}

export function withPeerVerification(prev: VoiceState, v: PeerVerification): VoiceState {
  const next = new Map(prev.peerVerifications);
  next.set(v.userId, v);
  return { ...prev, peerVerifications: next };
}

export function withoutPeerVerification(prev: VoiceState, userId: number): VoiceState {
  if (!prev.peerVerifications?.has(userId)) return prev;
  const next = new Map(prev.peerVerifications);
  next.delete(userId);
  return { ...prev, peerVerifications: next };
}

export function withVoiceConfig(prev: VoiceState, payload: VoiceConfigPayload): VoiceState {
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
}
