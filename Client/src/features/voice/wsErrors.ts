// The voice `error` handlers (join rollback, password and capacity refusals,
// video rollback), split from wsHandlers.ts. Plain functions only:
// dispatcher.ts owns every subscription.
import { authStore } from "../../stores/auth.store";
import { voiceStore, leaveVoiceChannel, setSwitchingTo } from "../../stores/voice.store";
import { uiStore } from "../../stores/ui.store";
import { showToast } from "../../lib/ui/toast";
import { noteJoinFailed } from "./joinBackoff";
import {
  type JoinAnswerWait,
  forgetRefusedStay,
  joinSequence,
  refusalWasPasswordRetry,
  takeJoinRefusal,
  takeRefusedJoin,
} from "./joinRequest";
import { noteVoiceLeave } from "./leaveOwed";
import { clearAfkMove } from "./moveHint";
import { livekitSession, log } from "../connection/dispatchContext";
import type { DispatchWs, Payload } from "../connection/dispatchContext";
import { connectText } from "../../i18n/connect";
import { WsErrorCode } from "@lib/protocolTypes";
import { handleCallRefusal } from "../direct-messages/callRefusal";
/**
 * The `error` chain's voice-join rollback. Acts only on the refusal of the
 * join in flight; never consumes the frame.
 */
export function handleVoiceJoinRollback(
  ws: DispatchWs,
  payload: Payload<"error">,
  id: string | undefined,
): void {
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
  // next checkpoint. It also reads true for a call the reconnect loop handed
  // to this join before its answer: no session is left by then, but the
  // server may still hold that call, and the voice_leave is what ends it.
  //
  // A switch out of a live call is the one join that names no channel in the
  // store while it waits (voiceStore.switchingTo): the server refuses a locked
  // or full channel before it leaves the call the user is in, so that call was
  // never touched here either and its refusal has nothing to undo.
  // Even when nothing is left to roll back (the user already left): an error
  // answering some other command names no join, so this drops nothing then.
  forgetRefusedStay(id);
  const { voiceStatus, currentChannelId, switchingTo = null } = voiceStore.getState();
  if (voiceStatus !== "joining" && switchingTo === null) return;
  if (!takeJoinRefusal(payload.code, id, switchingTo ?? currentChannelId)) return;
  // A refused join abandons an AFK move: nothing to explain.
  clearAfkMove();
  // A refused join (often before any voice token) is a failed join: back
  // off the next one, or every click re-sends voice_join. A password refusal
  // (and the rate limit on a password try) is the exception: the dialog it
  // opens is the retry, and a backoff would turn the user's next try away.
  // Any other refusal of a retry backs off as usual.
  const passwordRefusal =
    isPasswordCode(payload.code) ||
    (payload.code === WsErrorCode.RATE_LIMITED && refusalWasPasswordRetry(id));
  if (!passwordRefusal) noteJoinFailed();
  if (switchingTo !== null) {
    setSwitchingTo(null);
    // "Already joined" there means the server holds another call for this
    // socket than the one shown: end both sides, as for any other refusal.
    if (payload.code !== WsErrorCode.ALREADY_JOINED) return;
  }
  endRefusedJoin(ws);
}

/** Take down what a refused join left: the optimistic store entry, a session
 *  still up or connecting, and any call the server holds for this socket. */
function endRefusedJoin(ws: DispatchWs): void {
  // With no session here the server can still hold a call for this socket: a
  // join it granted whose token this device let pass (the user had already
  // clicked on) or never received, or the one a refused re-join found in
  // place. This device cannot tell, and shows no call from here on, so it
  // always sends a bare leave: the server ignores one from a socket that
  // holds nothing. A join sent while the session module was still loading
  // owns all of that instead.
  const refusedJoin = joinSequence();
  void livekitSession().then(({ isVoiceSessionActive, leaveVoice, failPendingRejoin }) => {
    failPendingRejoin();
    if (isVoiceSessionActive()) void leaveVoice(true);
    else if (joinSequence() === refusedJoin) {
      noteVoiceLeave();
      ws.send({ type: "voice_leave", payload: {} });
    }
  });
  leaveVoiceChannel();
}

/**
 * The join in flight got neither a voice_token nor a refusal in time (its
 * frame or its answer was lost with a socket): end it the way the user's own
 * Disconnect would, so the widget stops reading "Connecting…" and the server
 * drops whatever it holds for it. `socketConnected` is the chat socket now.
 */
export function handleVoiceJoinUnanswered(ws: DispatchWs, socketConnected: boolean): void {
  clearAfkMove();
  noteJoinFailed();
  const lostJoin = joinSequence();
  void livekitSession().then(({ leaveVoice }) => {
    // A join sent since owns the session.
    if (joinSequence() === lostJoin) void leaveVoice(false);
  });
  noteVoiceLeave();
  leaveVoiceChannel();
  if (socketConnected) ws.send({ type: "voice_leave", payload: {} });
  showToast(connectText("voice.joinUnanswered"), "error");
}

/** The wait a join's answer gets on this login's socket. The connection status
 *  mirrors the socket: "reconnecting" covers every state between connections. */
export function joinAnswerWaitFor(ws: DispatchWs): JoinAnswerWait {
  return {
    socketSettled: () => uiStore.getState().connectionStatus !== "reconnecting",
    onUnanswered: () =>
      handleVoiceJoinUnanswered(ws, uiStore.getState().connectionStatus === "connected"),
  };
}

export function isPasswordCode(code: string): boolean {
  return code === WsErrorCode.PASSWORD_REQUIRED || code === WsErrorCode.WRONG_PASSWORD;
}

/**
 * A join refused for its password: open the dialog for that channel. Runs
 * after the rollback, which already cleared the optimistic join. Acts only on
 * the refusal of the join this client sent last, so a stale or foreign error
 * never opens a dialog. Returns true when the frame was a password refusal (or
 * a retry's rate limit), so no generic toast follows.
 */
export function handleVoicePasswordRefusal(
  ws: DispatchWs,
  payload: Payload<"error">,
  id: string | undefined,
): boolean {
  const refused = takeRefusedJoin(id);
  if (refused === null || refused.channelId === null) return isPasswordCode(payload.code);
  const channelId = refused.channelId;
  let problem: "wrong" | "rateLimited" | null = null;
  if (payload.code === WsErrorCode.WRONG_PASSWORD) problem = "wrong";
  else if (payload.code === WsErrorCode.RATE_LIMITED && refused.passwordRetry)
    problem = "rateLimited";
  else if (payload.code !== WsErrorCode.PASSWORD_REQUIRED) return false;
  // Only this refusal needs the dialog, so it loads on demand. The prompt
  // registers its sign-out reset and its new-join listener only once loaded,
  // so a session that ended, or a join started, while the chunk was loading
  // must not get a dialog from it.
  const owner = authStore.getState().user?.id;
  const seq = joinSequence();
  void import("./passwordPrompt").then(
    ({ promptForChannelPassword }) => {
      if (owner === undefined || authStore.getState().user?.id !== owner) return;
      if (joinSequence() !== seq) return;
      promptForChannelPassword(ws, channelId, problem);
    },
    (err: unknown) => log.error("Password prompt failed to load", err),
  );
  return true;
}

/** The voice capacity refusals of `error`, and a refused call_ring that ends
 *  the caller's lone call. Returns true when the frame was one. */
export function handleVoiceError(payload: Payload<"error">, id: string | undefined): boolean {
  if (handleCallRefusal(payload, id)) return true;
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
      void import("./screenShare").then(({ rollbackPendingVideo }) => {
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
    void import("./screenShare").then(({ rollbackPendingVideo }) => {
      const kind = rollbackPendingVideo(id);
      if (kind === undefined) return;
      void livekitSession().then(({ disableCamera, disableScreenshare }) =>
        kind === "camera" ? disableCamera() : disableScreenshare(),
      );
    });
  }
}
