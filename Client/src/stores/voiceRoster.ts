/**
 * Pure reducers over the voice roster and the local speaking ring: each takes
 * the previous VoiceState and returns the next one, handing back the same
 * object when nothing changed so subscribers do not re-render. No store
 * access; voice.store.ts is the facade that runs them inside setState.
 */

import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
  VoiceSpeakersPayload,
} from "@lib/types";
import type { VoiceState, VoiceUser } from "./voiceModel";

/** The roster from a ready payload: channel id to user id to row. The payload
 *  carries the authoritative DB flags; blanking them on a mid-call resync
 *  would hide a peer's live camera/screenshare until they toggled it. Absent
 *  (older server) still defaults false. */
export function rosterFromReady(
  states: readonly ReadyVoiceState[],
  usernameOf: (userId: number) => string,
): Map<number, Map<number, VoiceUser>> {
  const channelMap = new Map<number, Map<number, VoiceUser>>();
  for (const vs of states) {
    let userMap = channelMap.get(vs.channel_id);
    if (!userMap) {
      userMap = new Map();
      channelMap.set(vs.channel_id, userMap);
    }
    userMap.set(vs.user_id, {
      userId: vs.user_id,
      username: usernameOf(vs.user_id),
      muted: vs.muted,
      deafened: vs.deafened,
      speaking: false,
      camera: vs.camera ?? false,
      screenshare: vs.screenshare ?? false,
      serverMuted: vs.server_muted ?? false,
      serverDeafened: vs.server_deafened ?? false,
    });
  }
  return channelMap;
}

/** The signed-in user's own row in a ready payload, when this device holds the
 *  call. While idle that row is another device's call and stays a roster entry
 *  (the sidebar still shows the user in the channel) without becoming this
 *  device's channel. */
export function ownReadyRow(
  states: readonly ReadyVoiceState[],
  userId: number,
  voiceStatus: VoiceState["voiceStatus"],
): ReadyVoiceState | undefined {
  if (userId === 0 || voiceStatus === "idle") return undefined;
  return states.find((vs) => vs.user_id === userId);
}

/** Add or replace one user's row from a voice_state event; for the signed-in
 *  user of a live call it also mirrors the moderator-imposed flags. */
export function withVoiceState(
  prev: VoiceState,
  payload: VoiceStatePayload,
  currentUserId: number,
): VoiceState {
  const serverMuted = payload.server_muted ?? false;
  const serverDeafened = payload.server_deafened ?? false;
  const nextChannels = new Map(prev.voiceUsers);
  const existingChannel = prev.voiceUsers.get(payload.channel_id);
  const nextUsers = new Map(existingChannel ?? []);
  // Preserve the LiveKit-authoritative speaking flag on an existing user:
  // setSpeakers is the only writer (LiveKit's ActiveSpeakersChanged). The
  // server's voice_state always ships speaking:false, so writing
  // payload.speaking verbatim here cleared the speaking ring on any
  // unrelated toggle that arrived between ActiveSpeakersChanged ticks. A
  // brand-new user has no prior value, so the payload seeds it.
  const existingUser = existingChannel?.get(payload.user_id);
  const speaking = existingUser !== undefined ? existingUser.speaking : payload.speaking;

  nextUsers.set(payload.user_id, {
    userId: payload.user_id,
    username: payload.username,
    muted: payload.muted,
    deafened: payload.deafened,
    speaking,
    camera: payload.camera,
    screenshare: payload.screenshare,
    serverMuted,
    serverDeafened,
  });

  nextChannels.set(payload.channel_id, nextUsers);
  // An idle device's own row is another device's call: roster only.
  if (payload.user_id !== currentUserId || prev.voiceStatus === "idle") {
    return { ...prev, voiceUsers: nextChannels };
  }
  return {
    ...prev,
    voiceUsers: nextChannels,
    localServerMuted: serverMuted,
    localServerDeafened: serverDeafened,
  };
}

/** Patch a user's username in every voice channel they occupy. */
export function withVoiceUsername(prev: VoiceState, userId: number, username: string): VoiceState {
  let changed = false;
  const nextChannels = new Map(prev.voiceUsers);
  for (const [channelId, users] of prev.voiceUsers) {
    const existing = users.get(userId);
    if (existing === undefined) continue;
    const nextUsers = new Map(users);
    nextUsers.set(userId, { ...existing, username });
    nextChannels.set(channelId, nextUsers);
    changed = true;
  }
  return changed ? { ...prev, voiceUsers: nextChannels } : prev;
}

/** Drop one user from a channel's roster, and from the watch sets. */
export function withoutVoiceUser(prev: VoiceState, payload: VoiceLeavePayload): VoiceState {
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

  const watching = prev.peerWatching;
  if (watching?.has(payload.user_id) !== true) return { ...prev, voiceUsers: nextChannels };
  const nextWatching = new Map(watching);
  nextWatching.delete(payload.user_id);
  return { ...prev, voiceUsers: nextChannels, peerWatching: nextWatching };
}

/** No LiveKit update reaches a channel this client is no longer in, so a ring
 *  lit there as it left would never clear. */
function withoutRings(
  voiceUsers: VoiceState["voiceUsers"],
  channelId: number | null,
): VoiceState["voiceUsers"] {
  const channel = channelId === null ? undefined : voiceUsers.get(channelId);
  if (channelId === null || channel === undefined) return voiceUsers;
  const next = new Map(voiceUsers);
  next.set(
    channelId,
    new Map(
      [...channel].map(([id, user]) => [id, user.speaking ? { ...user, speaking: false } : user]),
    ),
  );
  return next;
}

/** Record (or clear) the channel a switch out of a live call is waiting for. */
export function withSwitchingTo(prev: VoiceState, channelId: number | null): VoiceState {
  return (prev.switchingTo ?? null) === channelId ? prev : { ...prev, switchingTo: channelId };
}

/** Enter a channel locally. Already in it: the same state, so the timer is kept. */
export function withJoinedChannel(prev: VoiceState, channelId: number, now: number): VoiceState {
  if (prev.currentChannelId === channelId) return prev;
  return {
    ...prev,
    // A direct switch: the old channel's watch sets are not this one's.
    peerWatching: new Map<number, readonly number[]>(),
    voiceUsers: withoutRings(prev.voiceUsers, prev.currentChannelId),
    currentChannelId: channelId,
    joinedAt: now,
    // Whatever switch was waiting, this is where the user is heading now.
    switchingTo: null,
    // Optimistic: the widget shows "Connecting…" the moment the user clicks,
    // before the voice_token round-trip. livekitSession advances it from here.
    voiceStatus: "joining",
    shareDenied: false,
    // A fresh join starts clean — any degraded flag belongs to the
    // previous session's worker, not this one.
    encryptionDegraded: false,
  };
}

/** Leave the current channel and take the signed-in user off its roster. */
export function withLeftChannel(prev: VoiceState, currentUserId: number): VoiceState {
  const cleared = {
    currentChannelId: null,
    joinedAt: null,
    switchingTo: null,
    voiceStatus: "idle" as const,
    // Server mute lives with the voice session; a new session starts clean.
    localServerMuted: false,
    localServerDeafened: false,
    encryptionDegraded: false,
    shareDenied: false,
    peerVideoDecode: new Map<number, readonly string[]>(),
    peerKeySlots: new Set<number>(),
    peerBoundOffers: new Set<number>(),
    peerWatching: new Map<number, readonly number[]>(),
    localMusic: false,
    musicSharers: new Set<number>(),
  };
  const channelId = prev.currentChannelId;
  const voiceUsers = withoutRings(prev.voiceUsers, channelId);
  if (channelId === null || currentUserId === 0) {
    return { ...prev, ...cleared, voiceUsers };
  }
  const existingChannel = voiceUsers.get(channelId);
  if (!existingChannel || !existingChannel.has(currentUserId)) {
    return { ...prev, ...cleared, voiceUsers };
  }
  const nextChannels = new Map(voiceUsers);
  const nextUsers = new Map(existingChannel);
  nextUsers.delete(currentUserId);
  if (nextUsers.size === 0) {
    nextChannels.delete(channelId);
  } else {
    nextChannels.set(channelId, nextUsers);
  }
  return { ...prev, ...cleared, voiceUsers: nextChannels };
}

/** Apply the input-sensitivity gate to the local user's ring. A no-op when no
 *  gate runs (LiveKit then decides). The ring lights only while the gate is
 *  open and nothing silences the mic (self-mute, push-to-talk). */
export function withLocalRing(state: VoiceState, userId: number): VoiceState {
  const gate = state.localGateSpeaking;
  const channelId = state.currentChannelId;
  if (gate === null || gate === undefined || channelId === null) return state;
  const channel = state.voiceUsers.get(channelId);
  const user = channel?.get(userId);
  if (channel === undefined || user === undefined) return state;
  const speaking = gate && !state.localMuted && state.pttGated !== true;
  if (user.speaking === speaking) return state;
  const voiceUsers = new Map(state.voiceUsers);
  voiceUsers.set(channelId, new Map(channel).set(userId, { ...user, speaking }));
  return { ...state, voiceUsers };
}

/** Set every member's speaking flag from LiveKit's active speakers. */
export function withSpeakers(
  prev: VoiceState,
  payload: VoiceSpeakersPayload,
  userId: number,
): VoiceState {
  if (payload.channel_id !== prev.currentChannelId) return prev;
  const existingChannel = prev.voiceUsers.get(payload.channel_id);
  if (!existingChannel) return prev;

  const speakerSet = new Set(payload.speakers);
  const nextUsers = new Map<number, VoiceUser>();

  for (const [id, user] of existingChannel) {
    const isSpeaking = speakerSet.has(id);
    if (user.speaking !== isSpeaking) {
      nextUsers.set(id, { ...user, speaking: isSpeaking });
    } else {
      nextUsers.set(id, user);
    }
  }

  const nextChannels = new Map(prev.voiceUsers);
  nextChannels.set(payload.channel_id, nextUsers);
  return withLocalRing({ ...prev, voiceUsers: nextChannels }, userId);
}
