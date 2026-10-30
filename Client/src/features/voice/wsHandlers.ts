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
  joinVoiceChannel,
  leaveVoiceChannel,
  setVoiceConfig,
  setModeratorDeafened,
  restateSelfVoiceState,
  setPeerVideoDecode,
  setPeerWatching,
  noteWatchingResync,
  clearPeerWatching,
} from "../../stores/voice.store";
import { ensureIdentityKeyPublished } from "../../lib/net/identity";
import { showToast } from "../../lib/ui/toast";
import { noteJoinFailed } from "./joinBackoff";
import { takeWatchRefusal } from "../../lib/voice/watchRequest";
import { noteJoinSent, takeJoinRefusal } from "./joinRequest";
import { noteVoiceMoved, noteAfkMove, takeAfkMove, clearAfkMove } from "./moveHint";
import { channelsStore } from "../../stores/channels.store";
import { membersStore, memberDisplayName } from "../../stores/members.store";
import { livekitSession, cancelVoiceRejoin } from "../connection/dispatchContext";
import type {
  DispatchApi,
  DispatchWs,
  Payload,
  ReconnectClock,
} from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";
import { connectText } from "../../i18n/connect";
import { WsErrorCode } from "@lib/protocolTypes";

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
 * A moderator restriction must also be released once it is lifted.
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
 *
 * Lifting a moderator deafen also clears the row's own deafen (the server
 * cannot tell whose it was), so a member who had deafened themselves before
 * the moderator did would hear the room again unasked. The client knows:
 * `moderatorDeafened` marks a deafen it applied for the moderator, so any
 * other deafen in effect at the lift is the member's own, kept and restated
 * to the server. It follows the local deafen, not the moderator flags, so a
 * moderator move (a leave that clears those flags, then a re-join that
 * restates them) cannot mistake the moderator's deafen for the member's.
 */
function enforceModeratorAudioState(
  ws: DispatchWs,
  serverMuted: boolean,
  serverDeafened: boolean,
  prevServerMuted: boolean,
  prevServerDeafened: boolean,
  selfMuted: boolean,
  selfDeafened: boolean,
): void {
  const voice = voiceStore.getState();
  const applyDeafen = serverDeafened && !voice.localDeafened;
  if (applyDeafen) setModeratorDeafened(true);
  const deafenLifted = prevServerDeafened && !serverDeafened;
  const keepOwnDeafen = deafenLifted && voice.localDeafened && voice.moderatorDeafened !== true;
  if (deafenLifted) setModeratorDeafened(false);
  if (keepOwnDeafen) ws.send({ type: "voice_deafen", payload: { deafened: true } });
  const applyMute = serverMuted && !voice.localMuted;
  const releaseMute = prevServerMuted && !serverMuted && voice.localMuted && !selfMuted;
  const releaseDeafen = deafenLifted && !keepOwnDeafen && voice.localDeafened && !selfDeafened;
  if (applyDeafen || applyMute || releaseMute || releaseDeafen) {
    void livekitSession().then(({ setDeafened, setMuted }) => {
      if (applyDeafen) setDeafened(true);
      if (applyMute) setMuted(true);
      if (releaseMute) setMuted(false);
      if (releaseDeafen) setDeafened(false);
    });
  }
}

/**
 * The voice slice of `ready`, in two steps. Call this first: it snapshots the
 * voice state `ready` is about to replace, and returns the function that
 * restates the voice states and reconciles a surviving session against that
 * snapshot.
 */
export function snapshotReadyVoice(): (ws: DispatchWs, payload: Payload<"ready">) => void {
  // Snapshot the current voice channel's peer roster BEFORE the
  // wholesale replace below, so the reconciliation branch further down
  // can tell who left while the socket was down. Must run before
  // setVoiceStates() overwrites voiceUsers with the fresh payload.
  const prevVoiceChannelId = voiceStore.getState().currentChannelId;
  const prevVoicePeerIds =
    prevVoiceChannelId !== null
      ? new Set(voiceStore.getState().voiceUsers.get(prevVoiceChannelId)?.keys() ?? [])
      : new Set<number>();
  // Same reasoning as the VOICE_STATE handler — snapshot the
  // pre-resync moderator flags before setVoiceStates() overwrites them,
  // so a moderator restriction lifted while we were disconnected (and
  // still applied locally from before the drop) is released here too.
  const prevSelfServerMuted = voiceStore.getState().localServerMuted ?? false;
  const prevSelfServerDeafened = voiceStore.getState().localServerDeafened ?? false;
  return (ws, payload) => {
    setVoiceStates(payload.voice_states);
    // A reconnect supersedes any AFK move still awaiting its join
    // acknowledgement: that move was abandoned, so it earns no toast.
    clearAfkMove();

    // A self row in `ready` while this device holds no call (voiceStatus
    // "idle") is another device's call: one account keeps a connection per
    // device and the server broadcasts the user's voice rows to all of them.
    // Do not send voice_leave and do not leaveVoiceChannel() — that would end
    // the other device's call. The server already retires this device's own
    // stale call when it connects afresh (e.g. after an F5 reload), so no
    // defensive leave is needed here; the row stays in the roster only.
    //
    // The store's lifecycle status stands in for livekitSession (lazily
    // imported): any status but "idle" means this device is driving a
    // session right now.
    const currentUserId = authStore.getState().user?.id ?? 0;
    const selfVoiceState =
      currentUserId !== 0
        ? payload.voice_states.find((vs) => vs.user_id === currentUserId)
        : undefined;
    const voiceSessionActive = voiceStore.getState().voiceStatus !== "idle";
    if (selfVoiceState !== undefined && voiceSessionActive) {
      // A LiveKit session survived a WS drop that outlived it (nothing
      // tears voice down on a socket drop alone): this full
      // resync is the only place a moderator mute/deafen issued while we
      // were disconnected ever reaches us, since the mustFullResync tier
      // that produced this `ready` never replays the voice_state that
      // would otherwise have carried it.
      enforceModeratorAudioState(
        ws,
        selfVoiceState.server_muted === true,
        selfVoiceState.server_deafened === true,
        prevSelfServerMuted,
        prevSelfServerDeafened,
        selfVoiceState.muted,
        selfVoiceState.deafened,
      );
      // The socket was down: tell the server any mute/deafen toggled meanwhile.
      // enforceModeratorAudioState applies its releases later, so a moderator
      // restriction in play on either side of the outage is left to it.
      const modMuted = prevSelfServerMuted || selfVoiceState.server_muted === true;
      const modDeafened = prevSelfServerDeafened || selfVoiceState.server_deafened === true;
      restateSelfVoiceState(ws, modMuted || modDeafened, modDeafened);
      // The server does not re-relay a resumed member's own watch set to
      // peers: send ours again, and keep the viewer sounds out of the re-sync.
      noteWatchingResync();
      clearPeerWatching();

      // Same gap, for E2EE. A full resync never replays the
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
      const left: number[] = [];
      if (prevVoiceChannelId === selfVoiceState.channel_id) {
        const currentVoicePeerIds = new Set(
          payload.voice_states
            .filter((vs) => vs.channel_id === selfVoiceState.channel_id)
            .map((vs) => vs.user_id),
        );
        for (const uid of prevVoicePeerIds) {
          if (uid !== currentUserId && !currentVoicePeerIds.has(uid)) left.push(uid);
        }
      }
      // The same gap for the camera and share flags: an announce sent while
      // the socket was down never reached the server.
      for (const uid of left) setPeerVideoDecode(uid, undefined);
      void livekitSession().then(
        ({ handleParticipantLeft, reconcileVideoFlags, resendWatching }) => {
          for (const uid of left) void handleParticipantLeft(uid);
          resendWatching();
          if (prevVoiceChannelId === selfVoiceState.channel_id)
            reconcileVideoFlags(
              selfVoiceState.camera === true,
              selfVoiceState.screenshare === true,
            );
        },
      );
    }
  };
}

/** The identity slice of `ready`: publish our identity public key. */
export function publishReadyIdentity(
  api: DispatchApi | undefined,
  payload: Payload<"ready">,
): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  // Publish our long-term identity public key so peers can pin+verify
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

export function handleVoiceState(ws: DispatchWs, payload: Payload<"voice_state">): void {
  // Auto-join voice channel if the event is for the current user
  const currentUserId = authStore.getState().user?.id ?? 0;
  const isSelf = payload.user_id === currentUserId;
  // Snapshot the pre-update moderator flags before updateVoiceState
  // overwrites them, so enforceModeratorAudioState can detect a falling
  // edge (a restriction that WAS in effect and is now lifted) rather than
  // only ever seeing the post-update state.
  const prevServerMuted = isSelf ? (voiceStore.getState().localServerMuted ?? false) : false;
  const prevServerDeafened = isSelf ? (voiceStore.getState().localServerDeafened ?? false) : false;
  updateVoiceState(payload);
  if (!isSelf) return;
  // A self row while this device holds no call is another device's call (one
  // account, one call, one device): the roster is updated, nothing else. This
  // device's own join moves voiceStatus off "idle" before the server's answer.
  if (voiceStore.getState().voiceStatus === "idle") return;
  joinVoiceChannel(payload.channel_id);
  // The server's answer to the join that followed an AFK move: only now is
  // the move real, so only now does the user hear why.
  if (takeAfkMove(payload.channel_id)) {
    const name = channelsStore.getState().channels.get(payload.channel_id)?.name;
    showToast(
      connectText("voice.movedAfk", { channel: name ?? connectText("voice.afkChannelFallback") }),
      "info",
    );
  }
  enforceModeratorAudioState(
    ws,
    payload.server_muted === true,
    payload.server_deafened === true,
    prevServerMuted,
    prevServerDeafened,
    payload.muted,
    payload.deafened,
  );
}

// Tell the member who moved them. A moderator move is final once the
// server sends it, so unlike the AFK notice this does not wait for the join's
// acknowledgement. The mover's name or the channel may be unknown to this
// client; the message degrades rather than names nobody.
function announceModeratorMove(byUserId: number, toChannelId: number): void {
  const channel =
    channelsStore.getState().channels.get(toChannelId)?.name ??
    connectText("voice.movedChannelFallback");
  const mover = membersStore.getState().members.get(byUserId);
  showToast(
    mover === undefined
      ? connectText("voice.movedGeneric", { channel })
      : connectText("voice.movedBy", { name: memberDisplayName(mover), channel }),
    "info",
  );
}

// A moderator moved this client: tear the media session down and re-join the
// destination through the ordinary join path (the server already removed us
// from the old room and broadcast voice_leave).
export function handleVoiceMoved(
  ws: DispatchWs,
  payload: Payload<"voice_moved">,
  clock: ReconnectClock,
): void {
  log.info("Moved to another voice channel by a moderator", {
    toChannelId: payload.to_channel_id,
  });
  // A move is a deliberate membership change, so a pending
  // restart-rejoin for the old channel must not fire.
  cancelVoiceRejoin(clock);
  // Noted at once, so the leave sound queued by the voice_leave just before
  // this frame sees the move and stays silent.
  noteVoiceMoved(payload.to_channel_id);
  if (payload.reason === "afk") noteAfkMove(payload.to_channel_id);
  else {
    clearAfkMove();
    if (payload.by_user_id !== undefined)
      announceModeratorMove(payload.by_user_id, payload.to_channel_id);
  }
  void livekitSession().then(({ leaveVoice }) => {
    void leaveVoice(false);
    leaveVoiceChannel();
    joinVoiceChannel(payload.to_channel_id);
    noteJoinSent(ws.send({ type: "voice_join", payload: { channel_id: payload.to_channel_id } }));
  });
}

// A moderator disconnected this client from voice. voice_leave has already
// cleared the store; this only surfaces the reason.
export function handleVoiceDisconnected(
  payload: Payload<"voice_disconnected">,
  clock: ReconnectClock,
): void {
  // This can arrive well after the kick already tore the
  // session down at the SFU (queued behind a backed-up outbound send
  // buffer) — by the time it's delivered the user may have already
  // rejoined this channel or another. Guard on channel match, same as
  // the sibling VOICE_LEAVE handler below (shouldTeardownSession) — a
  // stale frame for a channel already left must not kill a newer join.
  // Read the store before leaveVoiceChannel() below clears
  // currentChannelId.
  //
  // On the ordinary kick path, the server sends voice_leave to
  // the leaver (finishVoiceLeave) BEFORE handleVoiceModKickV2 sends this
  // voice_disconnected, so the sibling VOICE_LEAVE handler has typically
  // already nulled currentChannelId by the time this arrives. That's not
  // the staleness (a rejoin into a *different* channel) — treat
  // a cleared store as not-stale so the kick reason still gets shown.
  const cur = voiceStore.getState().currentChannelId;
  const stale = cur !== null && cur !== payload.channel_id;
  if (stale) {
    log.info("Ignoring stale voice_disconnected for a channel already left", {
      channelId: payload.channel_id,
    });
    return;
  }
  // A kick is a deliberate membership change, so a pending
  // restart-rejoin must not put the user back.
  cancelVoiceRejoin(clock);
  clearAfkMove();
  log.info("Disconnected from voice by a moderator", { channelId: payload.channel_id });
  void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
  leaveVoiceChannel();
  showToast(payload.reason || connectText("voice.disconnected"), "error");
}

export function handleVoiceLeave(payload: Payload<"voice_leave">, clock: ReconnectClock): void {
  // removeVoiceUser() below always mutates the roster before
  // handleParticipantLeft below runs, and a pre-mutation snapshot (the
  // earlier attempt this replaced) reads "still present" on every
  // genuine departure too — a departing peer is only ever removed from
  // the roster by this very handler, so any roster read taken here, at
  // any point relative to that mutation, cannot tell a genuine departure
  // apart from the stale-leave case. Don't try; see
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
  // Leaving after an AFK move was noted ends the move; the leave that
  // precedes the voice_moved frame arrives before the note is made.
  if (isSelf) clearAfkMove();
  // Notify E2EE state machine so key holder can rotate the room key, and
  // (when applicable) tear down the media session — both through one lazy
  // import so the two effects cannot land in different ticks.
  // voice_leave is broadcast to the whole channelReadAudience,
  // i.e. everyone with READ_MESSAGES on THAT channel — not just its
  // voice participants. Scope the E2EE notification to this client's own
  // voice channel so a peer leaving a channel we merely read (and never
  // shared a call with) cannot delete their key, clear their
  // verification, or trigger a room-key rotation in our live session.
  // Clear local voice state only for the same channel-match case: a channel
  // switch optimistically moves the store's currentChannelId to the NEW
  // channel before the server responds (VoiceCallbacks.onVoiceJoin); the
  // server always leaves the OLD channel first, so an unconditional clear
  // here would blank the store back to null on every switch — hiding the
  // whole voice widget (including its leave/mute controls) until a later
  // voice_state happens to restore it, or forever if the switch then fails
  // server-side.
  // P2-T5: while the auto-reconnect loop owns the session, it decides what a
  // released membership means — it rejoins, or gives up with its toast. Only a
  // "reconnecting" badge can mean the loop, so any other clears the store now.
  const loopMayOwn = voiceStore.getState().voiceStatus === "reconnecting";
  if (shouldTeardownSession && !loopMayOwn) leaveVoiceChannel();
  // A rejoin may come from another client; its own announce restates the list.
  setPeerVideoDecode(payload.user_id, undefined);
  void livekitSession().then(({ handleParticipantLeft, leaveVoice, isAutoReconnecting }) => {
    if (sameChannel) void handleParticipantLeft(payload.user_id);
    if (shouldTeardownSession && !isAutoReconnecting()) {
      void leaveVoice(false);
      if (loopMayOwn) leaveVoiceChannel();
    }
  });
  // A self voice_leave means the user is out of voice for real — their
  // own Disconnect, or a server-initiated eviction. Either way a pending
  // restart-rejoin must not fire. Cancelled on `isSelf` rather than the
  // channel match above: the restart drop already nulled currentChannelId, so
  // `shouldTeardownSession` is false here while the rejoin is still pending.
  if (isSelf) cancelVoiceRejoin(clock);
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

/** Most decode entries kept from one announce (the server allows 8). */
const MAX_VIDEO_DECODE = 8;

/** The announce's `video_decode` when it is an array of strings (capped), else
 *  undefined. The wire is untrusted: a malformed list must read as absent. */
function narrowVideoDecode(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: unknown[] = value;
  if (!list.every((entry): entry is string => typeof entry === "string")) return undefined;
  return list.slice(0, MAX_VIDEO_DECODE);
}

export function handleVoiceE2eeAnnounce(payload: Payload<"voice_e2ee_announce">): void {
  // The decode list rides with the key. Record it before the E2EE hand-off so
  // a list that arrives before key setup is not lost; absent clears the entry.
  // It must never keep the key from being processed, hence the guard.
  try {
    setPeerVideoDecode(payload.user_id, narrowVideoDecode(payload.video_decode));
  } catch (err) {
    log.warn("voice_e2ee_announce: could not record video_decode", err);
  }
  void livekitSession().then(({ handleE2EEAnnounce }) =>
    // The announcing device's own key rides along only when the server sent one
    // (older servers do not); the wire is untrusted, so anything but a string
    // reads as absent.
    typeof payload.identity_public_key === "string" && payload.identity_public_key !== ""
      ? handleE2EEAnnounce(
          payload.user_id,
          payload.public_key,
          payload.signature,
          payload.identity_public_key,
        )
      : handleE2EEAnnounce(payload.user_id, payload.public_key, payload.signature),
  );
}

/** Whose screen shares a member of our channel watches (6.6). The wire is
 *  untrusted: non-integer entries are dropped, and the store ignores a user
 *  who is not in our current channel's roster (one that already left). */
export function handleVoiceWatching(payload: Payload<"voice_watching">): void {
  const raw: unknown = payload.user_ids;
  const ids = Array.isArray(raw)
    ? [...new Set((raw as unknown[]).filter((v): v is number => Number.isInteger(v)))].toSorted(
        (a, b) => a - b,
      )
    : [];
  setPeerWatching(payload.user_id, ids);
}

/** An error answering our voice_watch is swallowed (an old server does not
 *  know the type); a rate-limited one re-sends the set once after a second.
 *  True when the frame was ours. */
export function handleVoiceWatchError(payload: Payload<"error">, id: string | undefined): boolean {
  if (!takeWatchRefusal(id)) return false;
  if (payload.code === WsErrorCode.RATE_LIMITED) {
    void livekitSession()
      .then(({ retryWatching }) => retryWatching())
      .catch((err: unknown) => log.debug("voice_watch retry failed", err));
  }
  return true;
}

export function handleVoiceE2eeOffer(payload: Payload<"voice_e2ee_offer">): void {
  void livekitSession().then(({ handleE2EEOffer }) =>
    handleE2EEOffer(payload.from_user_id, payload.encrypted_key, payload.iv),
  );
}

/**
 * The `error` chain's voice-join rollback. Acts only on the refusal of the
 * join in flight; never consumes the frame.
 */
export function handleVoiceJoinRollback(payload: Payload<"error">, id: string | undefined): void {
  // The sidebar/widget optimistically writes currentChannelId
  // before the server answers voice_join (VoiceCallbacks.onVoiceJoin,
  // voiceStatus="joining"). A first-time join refusal earns no
  // voice_leave (there was no previous channel to leave), so nothing
  // else ever clears that optimistic state — setVoiceStatus("idle") only
  // runs inside LiveKitSession.leaveVoice(). handleVoiceJoin can refuse
  // for CHANNEL_FULL, VOICE_ERROR, FORBIDDEN, NOT_FOUND, BAD_REQUEST,
  // RATE_LIMITED, ALREADY_JOINED, or INTERNAL, and every refusal echoes
  // the join's envelope id (voice_join.go, buildErrorMsgWithID). Only that
  // refusal rolls the join back: an error answering another command (a
  // refused chat_edit, a rate-limited typing frame) used to cancel the
  // join too. An older server sends the refusal with no id, so an id-less
  // error still counts when its code is one a join refusal can carry
  // (joinRequest.ts). A channel *switch* refusal hits the same guard: the
  // self voice_leave for the OLD channel that precedes it no longer resets
  // voiceStatus (that voice_leave's channel no longer matches the already-updated
  // currentChannelId, so it must not tear down the NEW channel's
  // optimistic state either), so voiceStatus is still "joining" when
  // this error lands and the guard clears it here instead. A plain
  // store rollback is safe for an already-established session (never
  // "joining") and for a first-time join refusal (no prior session to
  // tear down) — but a channel *switch* refused at precheck (RATE_LIMITED,
  // FORBIDDEN, NOT_FOUND, archived-channel BAD_REQUEST) never reaches
  // voiceJoinLeaveCurrent server-side, so no voice_leave is broadcast and
  // the OLD channel's LiveKit room is still connected (mic still
  // published) while the store already points at the NEW channel.
  // isVoiceSessionActive() distinguishes that live-or-in-flight
  // case from the first-time-join refusal; tearing it down here also
  // sends voice_leave so the server/SFU state matches the now-cleared
  // store. isVoiceConnected() (Room !== null) reads false for
  // the entire "connecting" state — the very state a join is in while
  // voiceStatus is "joining" and connectAndSetup() still awaits
  // createRoom()/resolveLiveKitUrl() — so an unrelated error landing in
  // that window used to roll back only the store while the connect
  // attempt ran to completion unseen (hot mic, no UI). isVoiceSessionActive()
  // also covers "connecting"/"reconnecting", and leaveVoice() itself
  // already tolerates a null Room, aborting the in-flight attempt at its
  // next checkpoint.
  if (voiceStore.getState().voiceStatus === "joining" && takeJoinRefusal(payload.code, id)) {
    // A refused join abandons an AFK move: nothing to explain.
    clearAfkMove();
    // A refused join (often before any voice token) is a failed join: back
    // off the next one, or every click re-sends voice_join.
    noteJoinFailed();
    void livekitSession().then(({ isVoiceSessionActive, leaveVoice, failPendingRejoin }) => {
      failPendingRejoin();
      if (isVoiceSessionActive()) void leaveVoice(true);
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
  if (payload.code === WsErrorCode.CHANNEL_FULL) {
    showToast(connectText("voice.channelFull"), "error");
    return true;
  }
  if (payload.code === WsErrorCode.VIDEO_LIMIT) {
    showToast(connectText("voice.videoLimit"), "error");
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
      void import("../../lib/voice/screenShare").then(({ rollbackPendingVideo }) => {
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
    void import("../../lib/voice/screenShare").then(({ rollbackPendingVideo }) => {
      const kind = rollbackPendingVideo(id);
      if (kind === undefined) return;
      void livekitSession().then(({ disableCamera, disableScreenshare }) =>
        kind === "camera" ? disableCamera() : disableScreenshare(),
      );
    });
  }
}
