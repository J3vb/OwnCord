// Voice WebSocket handlers — extracted from lib/dispatcher.ts, which keeps
// every socket subscription and calls these plain functions. Every LiveKit
// and screen-share call goes through a dynamic import: dispatcher.ts is in the
// startup chunk, and livekit-client must stay out of it.
import { enforceModeratorAudioState } from "./wsReady";
import { authStore } from "../../stores/auth.store";
import {
  voiceStore,
  updateVoiceState,
  removeVoiceUser,
  joinVoiceChannel,
  leaveVoiceChannel,
  setVoiceConfig,
  setPeerVideoDecode,
  setPeerKeySlots,
  setPeerBoundOffers,
  setPeerWatching,
} from "../../stores/voice.store";
import { showToast } from "../../lib/ui/toast";
import { takeWatchRefusal } from "../../lib/voice/watchRequest";
import { applyVideoBitrateCap } from "./videoBitrateCap";
import { noteJoinAnswered, noteJoinSent, setJoinAnswerWait } from "./joinRequest";
import { joinAnswerWaitFor } from "./wsErrors";
import { noteVoiceMoved, noteAfkMove, takeAfkMove, clearAfkMove } from "./moveHint";
import { settleVoiceLeave } from "./leaveOwed";
import { channelsStore } from "../../stores/channels.store";
import { membersStore, memberDisplayName } from "../../stores/members.store";
import { livekitSession, cancelVoiceRejoin, log, route } from "../connection/dispatchContext";
import type { DispatchWs, Payload, ReconnectClock, WsRoute } from "../connection/dispatchContext";
import { connectText } from "../../i18n/connect";
import { WsErrorCode, ServerMessageType as S } from "@lib/protocolTypes";

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
  const { voiceStatus, currentChannelId } = voiceStore.getState();
  if (voiceStatus === "idle") return;
  // Only into the channel this device asked for. A self row naming another one
  // is the old call's echo (a mute or camera toggle sent just before a switch)
  // overtaken by the click: following it would point the store back at the
  // channel the server is about to take this device out of.
  if (currentChannelId === null || currentChannelId === payload.channel_id) {
    joinVoiceChannel(payload.channel_id);
  }
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
  if (isSelf) settleVoiceLeave(payload.channel_id);
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
  // released membership means — it rejoins, or gives up with its toast. A loop
  // for the store's own channel always shows the "reconnecting" badge (one the
  // user clicked away from runs under "joining", but the store then names the
  // other channel), so any other status clears the store now.
  const loopMayOwn = voiceStore.getState().voiceStatus === "reconnecting";
  if (shouldTeardownSession && !loopMayOwn) leaveVoiceChannel();
  // A rejoin may come from another client; its own announce restates the list.
  setPeerVideoDecode(payload.user_id, undefined);
  setPeerKeySlots(payload.user_id, false);
  setPeerBoundOffers(payload.user_id, false);
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

/** `video_bitrate_cap`: an admin saved the server's video upload cap. */
export function handleVideoBitrateCap(payload: Payload<"video_bitrate_cap">): void {
  applyVideoBitrateCap(payload.max_video_bitrate);
}

export function handleVoiceTokenFrame(payload: Payload<"voice_token">): void {
  noteJoinAnswered(payload.channel_id);
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
  try {
    setPeerKeySlots(payload.user_id, payload.key_slots === true);
    setPeerBoundOffers(payload.user_id, payload.bound_offers === true);
  } catch (err) {
    log.warn("voice_e2ee_announce: could not record key_slots", err);
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

export { snapshotReadyVoice, publishReadyIdentity } from "./wsReady";
export {
  handleVoiceJoinRollback,
  handleVoicePasswordRefusal,
  handleVoiceError,
  rollbackVideoOnError,
} from "./wsErrors";

/** The voice_token route also bounds the wait for that token: a join waits for
 *  its answer only while these routes are wired, on this login's socket. */
const voiceTokenRoute: WsRoute = {
  type: S.VOICE_TOKEN,
  attach: (subscribe, ctx) => {
    const off = subscribe(S.VOICE_TOKEN, handleVoiceTokenFrame);
    setJoinAnswerWait(joinAnswerWaitFor(ctx.ws));
    return () => {
      off();
      setJoinAnswerWait(null);
    };
  },
};

// Voice state, moves, tokens and the client-side E2EE key exchange.
export const wsRoutes: readonly WsRoute[] = [
  route(S.VOICE_STATE, (c) => (p) => handleVoiceState(c.ws, p)),
  route(S.VOICE_MOVED, (c) => (p) => handleVoiceMoved(c.ws, p, c.clock)),
  route(S.VOICE_DISCONNECTED, (c) => (p) => handleVoiceDisconnected(p, c.clock)),
  route(S.VOICE_LEAVE, (c) => (p) => handleVoiceLeave(p, c.clock)),
  route(S.VOICE_CONFIG, () => handleVoiceConfig),
  route(S.VIDEO_BITRATE_CAP, () => handleVideoBitrateCap),
  voiceTokenRoute,
  route(S.VOICE_E2EE_ANNOUNCE, () => handleVoiceE2eeAnnounce),
  route(S.VOICE_E2EE_OFFER, () => handleVoiceE2eeOffer),
  route(S.VOICE_WATCHING, () => handleVoiceWatching),
];
