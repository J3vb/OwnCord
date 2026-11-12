/**
 * Voice store — holds voice channel state, local audio controls, and per-user voice info.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type { WsClient } from "@lib/ws";
import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
} from "@lib/types";
import { membersStore } from "@stores/members.store";
import { channelsStore, isAfkChannel } from "@stores/channels.store";
import { authStore, registerVoiceLogoutTeardown } from "@stores/auth.store";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { noteJoinSucceeded } from "../features/voice/joinBackoff";
import { setVoiceDeafened, setVoiceInSession } from "@lib/voice/voiceDeafened";
import type { VoiceState, VoiceUser, PeerVerification, VoiceStatus } from "./voiceModel";
import { createVoiceState } from "./voiceModel";
import { saveSelfVoicePrefs, loadSelfVoicePrefs } from "./voiceSelfPrefs";
import {
  rosterFromReady,
  ownReadyRow,
  withVoiceState,
  withVoiceUsername,
  withoutVoiceUser,
  withJoinedChannel,
  withLeftChannel,
  withSwitchingTo,
  withLocalRing,
  withSpeakers,
} from "./voiceRoster";
import {
  withPeerVideoDecode,
  withPeerKeySlots,
  withPeerBoundOffers,
  withPeerWatching,
  withPeerVerification,
  withoutPeerVerification,
  withVoiceConfig,
  viewersOfShare,
  selfVoiceFrames,
} from "./voicePeers";

export type {
  VoiceUser,
  VoiceStatus,
  VoiceConfig,
  PeerVerification,
  VoiceState,
} from "./voiceModel";

const INITIAL_STATE: VoiceState = createVoiceState();

export const voiceStore = createStore<VoiceState>(INITIAL_STATE);

// Keep the sound module's session flag in step with channel membership on every
// edge (join, leave, channel switch, reconnect roster, logout) without that
// module importing this store. localDeafened itself is mirrored
// synchronously by setLocalDeafened/resetVoiceStore.
// App-lifetime: the store and this listener live as long as the app.
void voiceStore.subscribeSelector((state) => state.currentChannelId !== null, setVoiceInSession);

/** Keep `inAfkChannel` equal to "the current channel carries the AFK flag".
 *  The one writer: it runs when the current channel changes and when a channel
 *  row changes (ready, channel_create, channel_update), so a flag set while
 *  the user is already inside takes effect too. */
function syncInAfkChannel(): void {
  const afk = isAfkChannel(voiceStore.getState().currentChannelId);
  voiceStore.setState((prev) =>
    (prev.inAfkChannel ?? false) === afk ? prev : { ...prev, inAfkChannel: afk },
  );
}
// App-lifetime: both stores and these listeners live as long as the app.
void voiceStore.subscribeSelector((state) => state.currentChannelId, syncInAfkChannel);
// App-lifetime, as above.
void channelsStore.subscribeSelector((state) => state.channels, syncInAfkChannel);

/** Incremented by the incremental roster mutators (updateVoiceState,
 *  removeVoiceUser) — never by setVoiceStates, which replaces the whole
 *  roster on the initial `ready` and on a full resync. The voice UI sounds
 *  read it to tell a live join/leave edge from a wholesale replacement, so a
 *  reconnect replay cannot produce a sound storm. Module state, not store
 *  state: a listener only needs the delta since its last read, and a test
 *  fixture that restates VoiceState need not carry it. */
let voiceRosterRevision = 0;

/** Read `voiceRosterRevision` (see its comment). */
export function getVoiceRosterRevision(): number {
  return voiceRosterRevision;
}

/** Reset voice store to initial state (e.g. on logout). */
export function resetVoiceStore(): void {
  watchingResyncAt = Number.NEGATIVE_INFINITY;
  setVoiceDeafened(false);
  setVoiceInSession(false);
  voiceStore.setState(() => ({ ...createVoiceState(), inAfkChannel: false }));
}

registerVoiceLogoutTeardown({ snapshot: () => voiceStore.getState() });
// App-lifetime: the voice phase runs before any domain reset.
void registerSessionReset(
  "voice:store",
  () => {
    resetVoiceStore();
    noteJoinSucceeded();
  },
  { phase: "voice" },
);

/** Bulk set voice states from the ready payload. */
export function setVoiceStates(states: readonly ReadyVoiceState[]): void {
  const channelMap = rosterFromReady(
    states,
    (userId) => membersStore.getState().members.get(userId)?.username ?? "",
  );

  // Capture the user's own row so the moderator-imposed flags below can be
  // derived from it — a full-ready reconnect (mustFullResync / replay-buffer
  // miss) that preserves a live voice session must not leave localServerMuted/
  // localServerDeafened stuck at their pre-reconnect values.
  const currentUserId = authStore.getState().user?.id ?? 0;
  const selfState = ownReadyRow(states, currentUserId, voiceStore.getState().voiceStatus);
  const autoJoinChannel = selfState?.channel_id ?? null;

  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: channelMap,
    // If user is in a voice channel per ready payload, use that channel.
    // Otherwise preserve prev — user may be mid-join and server hasn't
    // registered them yet. Stale IDs are cleared by leaveVoiceChannel()
    // or resetVoiceStore() on logout.
    currentChannelId: autoJoinChannel ?? prev.currentChannelId,
    localServerMuted: selfState?.server_muted ?? false,
    localServerDeafened: selfState?.server_deafened ?? false,
  }));
}

/** Update or add a user's voice state from a voice_state event. When the event
 *  describes the signed-in user it also mirrors the moderator-imposed flags
 *  into localServerMuted/localServerDeafened, which gate the widget controls. */
export function updateVoiceState(payload: VoiceStatePayload): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  voiceRosterRevision++;
  voiceStore.setState((prev) => withVoiceState(prev, payload, currentUserId));
}

/** Patch a user's username in every voice channel they currently occupy.
 *  VoiceUser keeps its own frozen copy of the username (the same shape as
 *  membersStore's and dmStore's copies), refreshed only by setVoiceStates
 *  (ready) and updateVoiceState (voice_state) — a profile rename via
 *  USER_UPDATE must patch it too, or the voice roster keeps showing the old
 *  name for the rest of the call, until the user leaves and rejoins voice. */
export function updateVoiceUserProfile(userId: number, patch: { readonly username: string }): void {
  voiceStore.setState((prev) => withVoiceUsername(prev, userId, patch.username));
}

/** Remove a user from a voice channel. */
export function removeVoiceUser(payload: VoiceLeavePayload): void {
  voiceRosterRevision++;
  voiceStore.setState((prev) => withoutVoiceUser(prev, payload));
}

/**
 * Drop the whole roster of one channel. Used when the local user loses a group
 * DM (left or removed): the server stops sending that room's voice events, so
 * the stale participants would otherwise outlive the membership and reappear as
 * ghosts on a later re-add. The channel the local user is in is left alone: the
 * server's own voice_leave and the leave path handle that roster.
 */
export function clearChannelVoiceUsers(channelId: number): void {
  voiceStore.setState((prev) => {
    if (!prev.voiceUsers.has(channelId) || prev.currentChannelId === channelId) return prev;
    voiceRosterRevision++;
    const voiceUsers = new Map(prev.voiceUsers);
    voiceUsers.delete(channelId);
    return { ...prev, voiceUsers };
  });
}

/** Set the current voice channel (local join) and record the join timestamp.
 *  Only resets joinedAt if the user is joining a different channel (or was not in one). */
export function joinVoiceChannel(channelId: number): void {
  voiceStore.setState((prev) => withJoinedChannel(prev, channelId, Date.now()));
}

/** The channel a switch out of a live call waits for (see VoiceState.switchingTo). */
export function setSwitchingTo(channelId: number | null): void {
  voiceStore.setState((prev) => withSwitchingTo(prev, channelId));
}

/** Clear the current voice channel and remove current user from voice users. */
export function leaveVoiceChannel(): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  voiceStore.setState((prev) => withLeftChannel(prev, currentUserId));
}

/** Set the voice-session lifecycle status. Single-writer from livekitSession.ts
 *  at each connection-lifecycle transition. */
export function setVoiceStatus(status: VoiceStatus): void {
  voiceStore.setState((prev) =>
    prev.voiceStatus === status ? prev : { ...prev, voiceStatus: status },
  );
}

/** Mark whether the live E2EE encryption has degraded — set true
 *  from roomEventHandlers.ts when the room reports RoomEvent.EncryptionError
 *  (the SDK's own signal that the per-room worker died). Single-writer aside
 *  from the join/leave resets above, which clear it for a fresh session. */
export function setEncryptionDegraded(degraded: boolean): void {
  voiceStore.setState((prev) =>
    prev.encryptionDegraded === degraded ? prev : { ...prev, encryptionDegraded: degraded },
  );
}

/** Record that the local deafen is the one a moderator's deafen applied
 *  (see VoiceState.moderatorDeafened). */
export function setModeratorDeafened(applied: boolean): void {
  voiceStore.setState((prev) =>
    prev.moderatorDeafened === applied ? prev : { ...prev, moderatorDeafened: applied },
  );
}

/** Remember whether the member was muted at the moment they deafened. */
export function setMutedBeforeDeafen(muted: boolean): void {
  voiceStore.setState((prev) => ({ ...prev, mutedBeforeDeafen: muted }));
}

/** Toggle local mute state. */
export function setLocalMuted(muted: boolean): void {
  voiceStore.setState((prev) => withLocalRing({ ...prev, localMuted: muted }, ownUserId()));
}

/** Toggle local deafen state. */
export function setLocalDeafened(deafened: boolean): void {
  // Mirror into the leaf the always-loaded sound module reads, so
  // notification and voice sounds stay silent while deafened without that
  // module importing this store.
  setVoiceDeafened(deafened);
  voiceStore.setState((prev) => ({
    ...prev,
    localDeafened: deafened,
    moderatorDeafened: deafened && prev.moderatorDeafened === true,
  }));
}

/** Save the member's own mute and deafen so they survive a restart. Called
 *  after the member's own toggles only. */
export function saveSelfVoiceState(): void {
  saveSelfVoicePrefs(voiceStore.getState());
}

/** Load the saved mute and deafen into the store at session start. Outside a
 *  call only: a live call already carries the state its join applied. */
export function restoreSavedSelfVoiceState(): void {
  if (voiceStore.getState().currentChannelId !== null) return;
  const saved = loadSelfVoicePrefs();
  setVoiceDeafened(saved.localDeafened);
  voiceStore.setState((prev) => ({ ...prev, ...saved, moderatorDeafened: false }));
}

/** Record whether push-to-talk is currently gating (silencing) the mic —
 *  i.e. the bound key is not held. Written through livekitSession.setPttGated,
 *  which also closes or opens the mic processor's gate. Deliberately separate
 *  from localMuted so PTT can never write the flag that represents the user's
 *  own explicit mute (see the VoiceState.pttGated doc comment). */
export function setPttGated(gated: boolean): void {
  voiceStore.setState((prev) =>
    prev.pttGated === gated ? prev : withLocalRing({ ...prev, pttGated: gated }, ownUserId()),
  );
}

/** Whether the user's own mute is in effect. Push-to-talk never writes
 *  localMuted (its gate closes inside the mic processor), so this is the
 *  mute the user asked for: what the mic controls show. */
export function isSelfMuted(state: VoiceState): boolean {
  return state.localMuted;
}

/** Whether the Rust-side PTT key poller can report key state on this platform.
 *  A process-wide platform capability, not per-session state, so
 *  `resetVoiceStore()` must NOT clear it. It lives here, not in
 *  livekitSession.ts, so `ptt.ts` can write it at startup without pulling in
 *  the livekit-client SDK. Defaults to false so an unsupported poller never
 *  causes a join-time mute that nothing can later lift. */
let pttPollingLive = false;
const pttPollingListeners = new Set<() => void>();

/** Report whether the PTT key-polling backend can actually observe key state
 *  (the `ptt_polling_supported` command), not merely whether a key is bound:
 *  without a live backend no `ptt-state` event arrives to lift a join-time mute. */
export function setPttPollingLive(live: boolean): void {
  if (pttPollingLive === live) return;
  pttPollingLive = live;
  for (const listener of pttPollingListeners) listener();
}

/** Run `listener` whenever the poller goes live or stops, so the sensitivity
 *  gate can hand over to Push to Talk only once a key can actually gate. */
export function onPttPollingLiveChange(listener: () => void): () => void {
  pttPollingListeners.add(listener);
  return () => pttPollingListeners.delete(listener);
}

/** Whether the PTT poller is live (see `setPttPollingLive`). */
export function isPttPollingLive(): boolean {
  return pttPollingLive;
}

/** Toggle local camera state. */
export function setLocalCamera(enabled: boolean): void {
  voiceStore.setState((prev) => ({ ...prev, localCamera: enabled }));
}

/** Toggle local screenshare state. */
export function setLocalScreenshare(enabled: boolean): void {
  voiceStore.setState((prev) => ({ ...prev, localScreenshare: enabled }));
}

/** The live camera's capture was replaced (a device switch). */
export function bumpLocalCameraRev(): void {
  voiceStore.setState((prev) => ({ ...prev, localCameraRev: (prev.localCameraRev ?? 0) + 1 }));
}

/** The live share changed source or quality. */
export function bumpLocalShareRev(): void {
  voiceStore.setState((prev) => ({ ...prev, localShareRev: (prev.localShareRev ?? 0) + 1 }));
}

export function setShareDenied(denied: boolean): void {
  voiceStore.setState((prev) =>
    (prev.shareDenied === true) === denied ? prev : { ...prev, shareDenied: denied },
  );
}

/** Set listen-only mode (mic permission denied or no mic found). */
export function setListenOnly(listenOnly: boolean): void {
  voiceStore.setState((prev) => ({ ...prev, listenOnly }));
}

/** Store voice config for a channel from a voice_config event. */
export function setVoiceConfig(payload: VoiceConfigPayload): void {
  voiceStore.setState((prev) => withVoiceConfig(prev, payload));
}

function ownUserId(): number {
  return authStore.getState().user?.id ?? 0;
}

/** Record the input-sensitivity gate's verdict (null = no gate). It is read
 *  straight off the mic analyser, so the local ring follows speech without
 *  waiting for LiveKit's slower, louder-only speaker detection. */
export function setLocalGateSpeaking(speaking: boolean | null): void {
  voiceStore.setState((prev) =>
    prev.localGateSpeaking === speaking
      ? prev
      : withLocalRing({ ...prev, localGateSpeaking: speaking }, ownUserId()),
  );
}

/** Update speaking state for users from LiveKit's ActiveSpeakersChanged.
 *  Updates every remote user. The local user too, unless the input-sensitivity
 *  gate runs: then the gate decides (see setLocalGateSpeaking). */
export function setSpeakers(payload: VoiceSpeakersPayload): void {
  voiceStore.setState((prev) => withSpeakers(prev, payload, ownUserId()));
}

/** Record a peer's E2EE identity verification result. Written from
 *  livekitSession.ts as each peer's ephemeral-key announce is verified. */
export function setPeerVerification(v: PeerVerification): void {
  voiceStore.setState((prev) => withPeerVerification(prev, v));
}

/** Drop a single peer's verification (e.g. when they leave the channel). */
export function clearPeerVerification(userId: number): void {
  voiceStore.setState((prev) => withoutPeerVerification(prev, userId));
}

/** Publish (or clear, with null) the local user's own session fingerprint. */
export function setLocalSessionFingerprint(fingerprint: string | null): void {
  voiceStore.setState((prev) =>
    (prev.localSessionFingerprint ?? null) === fingerprint
      ? prev
      : { ...prev, localSessionFingerprint: fingerprint },
  );
}

/** Publish (or clear, with null) the local user's own safety number. */
export function setLocalSafetyNumber(safetyNumber: string | null): void {
  voiceStore.setState((prev) =>
    (prev.localSafetyNumber ?? null) === safetyNumber
      ? prev
      : { ...prev, localSafetyNumber: safetyNumber },
  );
}

/** Record a peer's reported video decode list; `undefined` (an announce
 *  without the field) deletes the entry. Single writer: the dispatcher's
 *  voice_e2ee_announce handler. */
export function setPeerVideoDecode(userId: number, list: readonly string[] | undefined): void {
  voiceStore.setState((prev) => withPeerVideoDecode(prev, userId, list));
}

/** Record whether a peer's announce said `key_slots`. Single writer: the
 *  dispatcher's voice_e2ee_announce handler. */
export function setPeerKeySlots(userId: number, keySlots: boolean): void {
  voiceStore.setState((prev) => withPeerKeySlots(prev, userId, keySlots));
}

/** Record whether a peer's announce said `bound_offers`. Single writer: the
 *  dispatcher's voice_e2ee_announce handler. */
export function setPeerBoundOffers(userId: number, boundOffers: boolean): void {
  voiceStore.setState((prev) => withPeerBoundOffers(prev, userId, boundOffers));
}

/** When the socket last resumed, for `isWatchingResync`. Module state: a
 *  listener only needs the instant, and no render reads it. */
let watchingResyncAt = Number.NEGATIVE_INFINITY;

/** The server re-sends every member's `voice_watching` after a resume; note
 *  the instant so the streamer's viewer sounds skip that re-sync. */
export function noteWatchingResync(): void {
  watchingResyncAt = Date.now();
}

/** Forget every member's watch set, ahead of the server re-sending them (a
 *  resume or full resync): a member who stopped while we were away sends no
 *  frame, so the old entry must not outlive the re-sync. */
export function clearPeerWatching(): void {
  voiceStore.setState((prev) =>
    (prev.peerWatching?.size ?? 0) === 0 ? prev : { ...prev, peerWatching: new Map() },
  );
}

/** True for a short while after `noteWatchingResync`. */
export function isWatchingResync(windowMs = 2000): boolean {
  return Date.now() - watchingResyncAt < windowMs;
}

/** Record whose screen shares a member of our current channel watches. A
 *  frame for a user who is not in that channel's roster (one that already
 *  left, or another channel's) is ignored; an empty list clears the entry.
 *  Single writer: the dispatcher's voice_watching handler. */
export function setPeerWatching(userId: number, watching: readonly number[]): void {
  voiceStore.setState((prev) => withPeerWatching(prev, userId, watching));
}

/** Who watches a member's screen share, as user ids: the channel members
 *  whose set has the sharer, plus you when you watch it locally (the local
 *  set lives in RemoteTracks, so the caller passes it), never the sharer.
 *  Empty unless the sharer's voice user has screenshare on. */
export function streamViewers(
  sharerId: number,
  watchingLocally = false,
  state: VoiceState = voiceStore.getState(),
): number[] {
  return viewersOfShare(state, sharerId, watchingLocally, ownUserId());
}

/** Drop all peer verifications (on voice leave). */
export function clearPeerVerifications(): void {
  voiceStore.setState((prev) =>
    (prev.peerVerifications?.size ?? 0) === 0 ? prev : { ...prev, peerVerifications: new Map() },
  );
}

/** Selector: a peer's verification result, or null if not yet resolved. */
export function getPeerVerification(userId: number): PeerVerification | null {
  return voiceStore.select((s) => s.peerVerifications?.get(userId) ?? null);
}

/** Selector: get all voice users in a specific channel. */
export function getChannelVoiceUsers(channelId: number): readonly VoiceUser[] {
  return voiceStore.select((s) => {
    const channelUsers = s.voiceUsers.get(channelId);
    if (!channelUsers) return [];
    return Array.from(channelUsers.values());
  });
}

// Re-tells the server our own mute/deafen when its row for us can differ from
// the local state: a fresh join or channel switch (the server writes the new
// row unmuted and undeafened, while the client keeps localMuted/localDeafened
// across a leave) and a chat socket that came back after the user toggled
// mute offline (the toggles apply locally and send nothing while it is down).
// skipMute/skipDeafen: the caller knows that state is a moderator's, not ours.
export function restateSelfVoiceState(
  ws: Pick<WsClient, "send">,
  skipMute = false,
  skipDeafen = false,
): void {
  const frames = selfVoiceFrames(voiceStore.getState(), ownUserId(), skipMute, skipDeafen);
  for (const frame of frames) ws.send(frame);
}
