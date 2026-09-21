// Voice WebSocket handlers — extracted from lib/dispatcher.ts, which keeps
// every socket subscription and calls these plain functions. Every LiveKit
// and screen-share call goes through a dynamic import: dispatcher.ts is in the
// startup chunk, and livekit-client must stay out of it.
import { authStore } from "../../stores/auth.store";
import {
  voiceStore,
  setVoiceStates,
  updateVoiceState,
  removeVoiceUser,
  setVoiceConfig,
  joinVoiceChannel,
  leaveVoiceChannel,
} from "../../stores/voice.store";
import { ensureIdentityKeyPublished } from "../../lib/identity";
import { createLogger } from "../../lib/logger";
import { showToast } from "../../lib/toast";
import { livekitSession } from "../connection/dispatchContext";
import type { DispatchContext, Payload } from "../connection/dispatchContext";

// Same logger tag as before the extraction, so the log lines are unchanged.
const log = createLogger("dispatcher");

/**
 * Honor a moderator's mute/deafen locally. Mute is also enforced at the SFU,
 * but deafen governs what WE play back, so the client is the only place it
 * can take effect (Server/ws/voice_moderation.go: "enforced by the target's
 * client honoring server_deafened"). Both apply through one lazy import so
 * the two effects cannot land in different ticks.
 *
 * Called from both the incremental VOICE_STATE path and the full-resync
 * READY path (a WS drop that outlives the LiveKit session can mean a
 * moderator mute/deafen issued while disconnected is only ever delivered via
 * `ready`'s voice_states, never a voice_state the client could have missed).
 * The `!voice.localMuted`/`!voice.localDeafened` guards make it safe to call
 * from either path — or both, on the same session — without redundantly
 * re-invoking the livekit calls once already applied.
 *
 * OC-0246: a moderator restriction must also be released once it is lifted.
 * `setMuted`/`setDeafened` deliberately send no voice_mute/voice_deafen frame
 * (unlike the user's own toggle), so nothing else ever un-applies a
 * moderator-imposed local mute/deafen — without this, the falling edge
 * (server_muted/server_deafened going back to false) left the client
 * permanently silent/deaf while every peer's roster, and the server's own
 * voice_states row, said otherwise. `prevServerMuted`/`prevServerDeafened`
 * scope the release to the exact frame the restriction was lifted on (a
 * falling edge), rather than to every voice_state that happens to show the
 * flag already false — the latter would risk undoing an in-flight optimistic
 * self-mute from an unrelated restated voice_state (e.g. a camera toggle).
 * `selfMuted`/`selfDeafened` are the row's own muted/deafened fields (never
 * touched by moderation, always kept in sync with the user's own toggle via
 * voice_mute/voice_deafen) — requiring them to also be false before
 * releasing means a genuine self-mute that happens to coincide with the
 * moderator's release is never clobbered.
 */
function enforceModeratorAudioState(
  serverMuted: boolean,
  serverDeafened: boolean,
  prevServerMuted: boolean,
  prevServerDeafened: boolean,
  selfMuted: boolean,
  selfDeafened: boolean,
): void {
  const voice = voiceStore.getState();
  const applyDeafen = serverDeafened && !voice.localDeafened;
  const applyMute = serverMuted && !voice.localMuted;
  const releaseMute = prevServerMuted && !serverMuted && voice.localMuted && !selfMuted;
  const releaseDeafen =
    prevServerDeafened && !serverDeafened && voice.localDeafened && !selfDeafened;
  if (applyDeafen || applyMute || releaseMute || releaseDeafen) {
    void livekitSession().then(({ setDeafened, setMuted }) => {
      if (applyDeafen) setDeafened(true);
      if (applyMute) setMuted(true);
      if (releaseMute) setMuted(false);
      if (releaseDeafen) setDeafened(false);
    });
  }
}

/** Pre-`ready` voice state, taken before setVoiceStates() overwrites it. */
export interface ReadyVoiceSnapshot {
  readonly prevVoiceChannelId: number | null;
  readonly prevVoicePeerIds: ReadonlySet<number>;
  readonly prevSelfServerMuted: boolean;
  readonly prevSelfServerDeafened: boolean;
}

/** Snapshot the voice state `ready` is about to replace. */
export function snapshotReadyVoice(): ReadyVoiceSnapshot {
  // OC-0201: snapshot the current voice channel's peer roster BEFORE the
  // wholesale replace below, so the reconciliation branch further down
  // can tell who left while the socket was down. Must run before
  // setVoiceStates() overwrites voiceUsers with the fresh payload.
  const prevVoiceChannelId = voiceStore.getState().currentChannelId;
  const prevVoicePeerIds =
    prevVoiceChannelId !== null
      ? new Set(voiceStore.getState().voiceUsers.get(prevVoiceChannelId)?.keys() ?? [])
      : new Set<number>();
  // OC-0246: same reasoning as the VOICE_STATE handler — snapshot the
  // pre-resync moderator flags before setVoiceStates() overwrites them,
  // so a moderator restriction lifted while we were disconnected (and
  // still applied locally from before the drop) is released here too.
  const prevSelfServerMuted = voiceStore.getState().localServerMuted ?? false;
  const prevSelfServerDeafened = voiceStore.getState().localServerDeafened ?? false;
  return { prevVoiceChannelId, prevVoicePeerIds, prevSelfServerMuted, prevSelfServerDeafened };
}

/** The voice slice of `ready`: restate voice states and reconcile a surviving session. */
export function applyReadyVoice(
  ctx: DispatchContext,
  payload: Payload<"ready">,
  snapshot: ReadyVoiceSnapshot,
): void {
  const { ws } = ctx;
  const { prevVoiceChannelId, prevVoicePeerIds, prevSelfServerMuted, prevSelfServerDeafened } =
    snapshot;
  setVoiceStates(payload.voice_states);

  // Defense-in-depth: if the ready payload shows us in a voice channel
  // but we have no LiveKit session (e.g. after F5 reload), send
  // voice_leave to clean up the stale state. The server should have
  // already cleaned this up, but this handles edge cases.
  //
  // livekitSession is lazily imported, so instead of the synchronous
  // isVoiceConnected() the check reads the voice store's lifecycle
  // status: "idle" means no live or pending LiveKit session (a fresh
  // reload always starts idle — exactly the stale case), while any other
  // status means livekitSession is driving a session right now.
  const currentUserId = authStore.getState().user?.id ?? 0;
  const selfVoiceState =
    currentUserId !== 0
      ? payload.voice_states.find((vs) => vs.user_id === currentUserId)
      : undefined;
  const voiceSessionActive = voiceStore.getState().voiceStatus !== "idle";
  if (selfVoiceState !== undefined && !voiceSessionActive) {
    log.warn("Stale voice state detected in ready payload — sending voice_leave");
    ws.send({ type: "voice_leave", payload: {} });
    leaveVoiceChannel();
  } else if (selfVoiceState !== undefined) {
    // A LiveKit session survived a WS drop that outlived it (nothing
    // tears voice down on a socket drop alone) — OC-0014: this full
    // resync is the only place a moderator mute/deafen issued while we
    // were disconnected ever reaches us, since the mustFullResync tier
    // that produced this `ready` never replays the voice_state that
    // would otherwise have carried it.
    enforceModeratorAudioState(
      selfVoiceState.server_muted === true,
      selfVoiceState.server_deafened === true,
      prevSelfServerMuted,
      prevSelfServerDeafened,
      selfVoiceState.muted,
      selfVoiceState.deafened,
    );

    // OC-0201: same gap, for E2EE. A full resync never replays the
    // voice_leave for anyone who departed our voice channel during the
    // outage — handleParticipantLeft (the only path that prunes a
    // departed peer's key, rotates for membership forward secrecy, and
    // re-runs the lowest-uid key-holder election) is otherwise only ever
    // driven by a live voice_leave frame. Without this, a departed peer
    // keeps a working room key indefinitely, and a client the server
    // just elected key holder on reconnect (Server/ws hub.go
    // registerNow -> updateKeyHolder) never self-elects. Only reconcile
    // when the resync's self voice state is for the SAME channel the
    // snapshot above was taken from — a channel change is out of scope
    // here and comparing rosters across two different channels would
    // misfire.
    if (prevVoiceChannelId === selfVoiceState.channel_id) {
      const currentVoicePeerIds = new Set(
        payload.voice_states
          .filter((vs) => vs.channel_id === selfVoiceState.channel_id)
          .map((vs) => vs.user_id),
      );
      for (const uid of prevVoicePeerIds) {
        if (uid === currentUserId || currentVoicePeerIds.has(uid)) continue;
        void livekitSession().then(({ handleParticipantLeft }) => handleParticipantLeft(uid));
      }
    }
  }
}

/** The identity slice of `ready` (F3): publish our identity public key. */
export function publishReadyIdentity(ctx: DispatchContext, payload: Payload<"ready">): void {
  const { api } = ctx;
  const currentUserId = authStore.getState().user?.id ?? 0;
  // F3: publish our long-term identity public key so peers can pin+verify
  // us in voice. Idempotent (no PATCH when the server copy already matches)
  // and fire-and-forget — never block the ready flow. Username is required
  // by the server's profile update, so it rides along with the key.
  const self = payload.members.find((m) => m.id === currentUserId);
  const host = api?.getConfig?.().host;
  if (self !== undefined && currentUserId !== 0 && host && api?.updateProfile) {
    const updateProfile = api.updateProfile;
    void ensureIdentityKeyPublished(host, self.username, self.identity_public_key ?? null, (data) =>
      updateProfile(data),
    );
  }
}

export function handleVoiceState(payload: Payload<"voice_state">): void {
  // Auto-join voice channel if the event is for the current user
  const currentUserId = authStore.getState().user?.id ?? 0;
  const isSelf = payload.user_id === currentUserId;
  // OC-0246: snapshot the pre-update moderator flags before updateVoiceState
  // overwrites them, so enforceModeratorAudioState can detect a falling
  // edge (a restriction that WAS in effect and is now lifted) rather than
  // only ever seeing the post-update state.
  const prevServerMuted = isSelf ? (voiceStore.getState().localServerMuted ?? false) : false;
  const prevServerDeafened = isSelf ? (voiceStore.getState().localServerDeafened ?? false) : false;
  updateVoiceState(payload);
  if (!isSelf) return;
  joinVoiceChannel(payload.channel_id);
  enforceModeratorAudioState(
    payload.server_muted === true,
    payload.server_deafened === true,
    prevServerMuted,
    prevServerDeafened,
    payload.muted,
    payload.deafened,
  );
}

// A moderator moved this client: tear the media session down and re-join the
// destination through the ordinary join path (the server already removed us
// from the old room and broadcast voice_leave).
export function handleVoiceMoved(ctx: DispatchContext, payload: Payload<"voice_moved">): void {
  const { ws } = ctx;
  log.info("Moved to another voice channel by a moderator", {
    toChannelId: payload.to_channel_id,
  });
  void livekitSession().then(({ leaveVoice }) => {
    leaveVoice(false);
    leaveVoiceChannel();
    joinVoiceChannel(payload.to_channel_id);
    ws.send({ type: "voice_join", payload: { channel_id: payload.to_channel_id } });
  });
}

// A moderator disconnected this client from voice. voice_leave has already
// cleared the store; this only surfaces the reason.
export function handleVoiceDisconnected(payload: Payload<"voice_disconnected">): void {
  // OC-0031: this can arrive well after the kick already tore the
  // session down at the SFU (queued behind a backed-up outbound send
  // buffer) — by the time it's delivered the user may have already
  // rejoined this channel or another. Guard on channel match, same as
  // the sibling VOICE_LEAVE handler below (shouldTeardownSession) — a
  // stale frame for a channel already left must not kill a newer join.
  // Read the store before leaveVoiceChannel() below clears
  // currentChannelId.
  //
  // OC-0033: on the ordinary kick path, the server sends voice_leave to
  // the leaver (finishVoiceLeave) BEFORE handleVoiceModKickV2 sends this
  // voice_disconnected, so the sibling VOICE_LEAVE handler has typically
  // already nulled currentChannelId by the time this arrives. That's not
  // the OC-0031 staleness (a rejoin into a *different* channel) — treat
  // a cleared store as not-stale so the kick reason still gets shown.
  const cur = voiceStore.getState().currentChannelId;
  const stale = cur !== null && cur !== payload.channel_id;
  if (stale) {
    log.info("Ignoring stale voice_disconnected for a channel already left", {
      channelId: payload.channel_id,
    });
    return;
  }
  log.info("Disconnected from voice by a moderator", { channelId: payload.channel_id });
  void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
  leaveVoiceChannel();
  showToast(payload.reason || "You were disconnected from voice", "error");
}

export function handleVoiceLeave(payload: Payload<"voice_leave">): void {
  // OC-0283: removeVoiceUser() below always mutates the roster before
  // handleParticipantLeft below runs, and a pre-mutation snapshot (the
  // OC-0239 attempt this replaced) reads "still present" on every
  // genuine departure too — a departing peer is only ever removed from
  // the roster by this very handler, so any roster read taken here, at
  // any point relative to that mutation, cannot tell a genuine departure
  // apart from the OC-0213 stale-leave case. Don't try; see
  // E2EEManager.handleParticipantLeft for the current defense.
  removeVoiceUser(payload);
  const currentUserId = authStore.getState().user?.id ?? 0;
  const isSelf = payload.user_id === currentUserId;
  // A server-initiated eviction (revocation sweep, channel delete) has no
  // companion teardown message — this voice_leave IS the signal that
  // drives our own LiveKit/E2EE teardown, or mic publish and key material
  // stay live while the UI shows not-in-voice. Guard on channel match: a
  // late-arriving voice_leave for a channel we already left (and rejoined
  // elsewhere) must not kill a newer join. Read the store before
  // leaveVoiceChannel() below clears currentChannelId.
  const sameChannel = voiceStore.getState().currentChannelId === payload.channel_id;
  const shouldTeardownSession = isSelf && sameChannel;
  // Notify E2EE state machine so key holder can rotate the room key, and
  // (when applicable) tear down the media session — both through one lazy
  // import so the two effects cannot land in different ticks.
  // OC-0311: voice_leave is broadcast to the whole channelReadAudience,
  // i.e. everyone with READ_MESSAGES on THAT channel — not just its
  // voice participants. Scope the E2EE notification to this client's own
  // voice channel so a peer leaving a channel we merely read (and never
  // shared a call with) cannot delete their key, clear their
  // verification, or trigger a room-key rotation in our live session.
  void livekitSession().then(({ handleParticipantLeft, leaveVoice }) => {
    if (sameChannel) void handleParticipantLeft(payload.user_id);
    if (shouldTeardownSession) void leaveVoice(false);
  });
  // Clear local voice state only for the same channel-match case as the
  // LiveKit teardown above. A channel switch optimistically moves the
  // store's currentChannelId to the NEW channel before the server
  // responds (VoiceCallbacks.onVoiceJoin); the server always leaves the
  // OLD channel first, so an unconditional clear here would blank the
  // store back to null on every switch — hiding the whole voice widget
  // (including its leave/mute controls) until a later voice_state
  // happens to restore it, or forever if the switch then fails
  // server-side.
  if (shouldTeardownSession) {
    leaveVoiceChannel();
  }
}

export function handleVoiceConfig(payload: Payload<"voice_config">): void {
  setVoiceConfig(payload);
}

export function handleVoiceTokenFrame(payload: Payload<"voice_token">): void {
  void livekitSession().then(({ handleVoiceToken }) =>
    handleVoiceToken(
      payload.token,
      payload.url,
      payload.channel_id,
      payload.direct_url,
      payload.is_key_holder,
    ),
  );
}

export function handleVoiceE2eeAnnounce(payload: Payload<"voice_e2ee_announce">): void {
  void livekitSession().then(({ handleE2EEAnnounce }) =>
    handleE2EEAnnounce(payload.user_id, payload.public_key, payload.signature),
  );
}

export function handleVoiceE2eeOffer(payload: Payload<"voice_e2ee_offer">): void {
  void livekitSession().then(({ handleE2EEOffer }) =>
    handleE2EEOffer(payload.from_user_id, payload.encrypted_key, payload.iv),
  );
}

/** The `error` chain's voice-join rollback. Runs for every error that reaches it; never consumes the frame. */
export function handleVoiceJoinRollback(): void {
  // OC-0224: the sidebar/widget optimistically writes currentChannelId
  // before the server answers voice_join (VoiceCallbacks.onVoiceJoin,
  // voiceStatus="joining"). A first-time join refusal earns no
  // voice_leave (there was no previous channel to leave), so nothing
  // else ever clears that optimistic state — setVoiceStatus("idle") only
  // runs inside LiveKitSession.leaveVoice(). handleVoiceJoin can refuse
  // for CHANNEL_FULL, VOICE_ERROR, FORBIDDEN, NOT_FOUND, BAD_REQUEST,
  // RATE_LIMITED, ALREADY_JOINED, or INTERNAL — this used to only roll
  // back CHANNEL_FULL, leaving the sidebar keyed on a channel with no
  // LiveKit session for every other refusal. voice_join's error replies
  // carry no envelope id to correlate against (Server/ws/voice_join.go
  // always answers with buildErrorMsg, never buildErrorMsgWithID), so —
  // unlike the pendingSends/pendingReactions correlation above — this
  // can't be scoped to "the refusal that answered this specific join";
  // it runs once, ahead of every code-specific branch below, for any
  // error that lands while a join is outstanding. A channel *switch*
  // refusal hits the same guard: the self voice_leave for the OLD
  // channel that precedes it no longer resets voiceStatus (OC-0015 —
  // that voice_leave's channel no longer matches the already-updated
  // currentChannelId, so it must not tear down the NEW channel's
  // optimistic state either), so voiceStatus is still "joining" when
  // this error lands and the guard clears it here instead. A plain
  // store rollback is safe for an already-established session (never
  // "joining") and for a first-time join refusal (no prior session to
  // tear down) — but a channel *switch* refused at precheck (RATE_LIMITED,
  // FORBIDDEN, NOT_FOUND, archived-channel BAD_REQUEST) never reaches
  // voiceJoinLeaveCurrent server-side, so no voice_leave is broadcast and
  // the OLD channel's LiveKit room is still connected (mic still
  // published) while the store already points at the NEW channel
  // (OC-0193). isVoiceSessionActive() distinguishes that live-or-in-flight
  // case from the first-time-join refusal; tearing it down here also
  // sends voice_leave so the server/SFU state matches the now-cleared
  // store. OC-0249: isVoiceConnected() (Room !== null) reads false for
  // the entire "connecting" state — the very state a join is in while
  // voiceStatus is "joining" and connectAndSetup() still awaits
  // createRoom()/resolveLiveKitUrl() — so an unrelated error landing in
  // that window used to roll back only the store while the connect
  // attempt ran to completion unseen (hot mic, no UI). isVoiceSessionActive()
  // also covers "connecting"/"reconnecting", and leaveVoice() itself
  // already tolerates a null Room, aborting the in-flight attempt at its
  // next checkpoint.
  if (voiceStore.getState().voiceStatus === "joining") {
    void livekitSession().then(({ isVoiceSessionActive, leaveVoice }) => {
      if (isVoiceSessionActive()) leaveVoice(true);
    });
    leaveVoiceChannel();
  }
}

/** The voice capacity refusals of `error`. Returns true when the frame was one. */
export function handleVoiceError(payload: Payload<"error">, id: string | undefined): boolean {
  // Voice capacity refusals. The server owns the limits (voice_max_users /
  // voice_max_video) and refuses the join or the camera; the client never
  // pre-blocks the click, because its copy of the participant list can lag
  // and a refusal it invented would be uncorrectable. So the only job here
  // is to say what happened — without this the click was a silent no-op
  // with an explanation buried in the log.
  if (payload.code === "CHANNEL_FULL") {
    showToast(payload.message || "That voice channel is full", "error");
    return true;
  }
  if (payload.code === "VIDEO_LIMIT") {
    showToast(payload.message || "That voice channel has reached its video limit", "error");
    // max_video has no SFU-level enforcement — the server only refuses the
    // DB write. Without this rollback the already-published track keeps
    // streaming to everyone while voice_state says camera/screenshare is
    // off. voice_controls.go routes both a refused voice_camera AND a
    // refused voice_screenshare enable through the same shared
    // enableVideoSlot cap check, so this code is not camera-specific —
    // correlate by envelope id, exactly like the generic rollback below,
    // instead of assuming it's always the camera. A bare VIDEO_LIMIT with
    // no id (older server / no correlation available) still falls back
    // to the camera, the only kind this branch used to handle.
    if (id !== undefined) {
      void import("../../lib/screenShare").then(({ rollbackPendingVideo }) => {
        const kind = rollbackPendingVideo(id);
        // undefined means this id no longer correlates to anything
        // pending (superseded by a later enable of the same kind) — the
        // refusal is stale and there is nothing to roll back. It must
        // never be treated as "it was the camera".
        if (kind === undefined) return;
        void livekitSession().then(({ disableCamera, disableScreenshare }) =>
          kind === "screen" ? disableScreenshare() : disableCamera(),
        );
      });
    } else {
      void livekitSession().then(({ disableCamera }) => disableCamera());
    }
    return true;
  }
  return false;
}

/** Roll back a refused camera/screenshare enable correlated by envelope id. */
export function rollbackVideoOnError(id: string | undefined): void {
  // A server refusal of a voice_camera/voice_screenshare enable other
  // than VIDEO_LIMIT (FORBIDDEN, RATE_LIMITED, INTERNAL, ...): roll back
  // the already-published track, or it keeps streaming to every peer
  // while the store says it's off. Correlated by envelope id — exactly
  // like pendingSends/pendingReactions above — so an unrelated
  // FORBIDDEN/RATE_LIMITED on some other action never touches video
  // state. screenShare.ts pulls in livekit-client at module scope, so —
  // like livekitSession() above — it's loaded lazily here too, at its
  // one call site in this file.
  if (id !== undefined) {
    void import("../../lib/screenShare").then(({ rollbackPendingVideo }) => {
      const kind = rollbackPendingVideo(id);
      if (kind === undefined) return;
      void livekitSession().then(({ disableCamera, disableScreenshare }) =>
        kind === "camera" ? disableCamera() : disableScreenshare(),
      );
    });
  }
}
