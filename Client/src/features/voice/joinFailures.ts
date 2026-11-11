// Synchronous failure and claim steps of the voice join orchestration, split
// from joinOrchestration.ts. Each is a whole synchronous step run right after
// the ownership check in JoinOrchestration; none awaits.
import { leaveVoiceChannel, voiceStore } from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import { logIceConnectionInfo } from "../../lib/voice/livekitDiagnostics";
import { setJoinedVoiceStatus } from "../../lib/voice/roomEventHandlers";
import { voiceText } from "../../i18n/voice";
import { releaseRoom } from "./releaseRoom";
import { advanceJoinStage, failJoinAttempt, redactTunnelUrl } from "../../lib/voice/voiceJoinTrace";
import { noteJoinFailed } from "./joinBackoff";
import type { JoinHost } from "./joinHost";
import {
  dropSuperseded,
  hasQueuedJoin,
  isStateConnected,
  ownsConnectAttempt,
  type JoinRequest,
} from "./joinSupport";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

// Same logger tag as before the extraction, so the join log lines are unchanged.
const log = createLogger("livekitSession");

/** The key exchange did not finish. setupKeyExchange() also returns false
 *  when clearState() aborted the wait (e.g. a supersession that ran
 *  leaveVoice() while we were blocked there) — indistinguishable from a
 *  genuine timeout by return value alone. Check ownership before treating
 *  it as a real failure: a superseded attempt must not fire a spurious
 *  toast, send voice_leave (it carries no channel id and would act on
 *  whichever channel the NEWER attempt just joined), or clear the store's
 *  currentChannelId that the newer join just set. */
export function onKeyExchangeFailed(
  host: JoinHost,
  localRoom: VoiceRoom,
  channelId: number,
  myGeneration: number,
  traceId: number,
): false | "superseded" {
  if (!ownsConnectAttempt(host, myGeneration)) {
    log.info("connectAndSetup: superseded during key exchange — aborting", {
      channelId,
      myGeneration,
    });
    return dropSuperseded(host, localRoom);
  }
  releaseRoom(localRoom).catch((err) =>
    log.debug("Failed to disconnect room after key exchange failure", err),
  );
  // A channel switch queued during the wait (handleVoiceToken's
  // pendingJoin branch) preserves this attempt's type/joinGeneration, so
  // the ownership check above cannot distinguish it from "no newer join
  // is coming". Treating it as a genuine failure here would send
  // voice_leave with no channel id — deleting the QUEUED join's
  // voice_states row, not this timed-out attempt's — and would drop the
  // pendingJoin itself by transitioning to idle before the drain loop
  // ever reads it. Only run the give-up cleanup when nothing is queued.
  if (!hasQueuedJoin(host)) {
    host.getOnError()?.(voiceText("join.securingTimeout"));
    // The exchange timed out BEFORE room.connect(): no SFU participant
    // exists, so no LiveKit webhook will ever clean up, and the server
    // registered the join when it sent voice_token. Send voice_leave and
    // leave the store's voice channel (like the reconnect-exhausted give-up
    // path) or the stale row ghosts forever and can wedge the channel's
    // key-holder election.
    host.leaveVoice(true, false);
    leaveVoiceChannel();
    noteJoinFailed();
  } else {
    // Leave state as "connecting" with pendingJoin intact so the finally
    // block and handleVoiceToken's drain loop can run the queued join.
    // Clear this attempt's own E2EE residue (keypair/_isKeyHolder/etc.)
    // so the queued join does not inherit it — entry-point leaveVoice(false)
    // never runs for that next call since `_room` is null here.
    host.getE2EE().clearState({ keepHeldAnnounces: true });
  }
  // SRE-M2: the key exchange is a real failure stage (timeout / aborted
  // exchange), recorded so a report can place it.
  failJoinAttempt(traceId);
  return false;
}

/** The room connected and this attempt still owns the session: make it
 *  the session. Runs in the same tick as the last checkpoint, so nothing
 *  (a queued join, a leave, a room event) can land in between. */
export function claimSession(
  host: JoinHost,
  localRoom: VoiceRoom,
  join: JoinRequest,
  resolvedUrl: string,
  traceId: number,
): void {
  const { token, url, channelId, directUrl } = join;
  advanceJoinStage(traceId, "activate");
  log.info("Connected to LiveKit room", { channelId, url: redactTunnelUrl(resolvedUrl) });
  logIceConnectionInfo(localRoom);
  // This attempt survived with its queued request identical to it (a
  // duplicate frame), so no queued session will take what was held:
  // stop holding or the live session would never see another announce,
  // and hand what was held for this channel to the live session.
  host.getE2EE().releaseHeldAnnounces(channelId);
  // Atomic transition to "connected" — all connection fields set together.
  host.setState({
    type: "connected",
    room: localRoom,
    channelId,
    latestToken: token,
    lastUrl: url,
    lastDirectUrl: directUrl,
  });
  // Room connected and E2EE key ready — the call is now secured. Shown only
  // while the store still names this channel: after a click on to another one
  // the status on screen is that join's, and this room is not where it leads.
  if (voiceStore.getState().currentChannelId === channelId) setJoinedVoiceStatus(localRoom);
  host.sweepPublications(localRoom);
  // Optimistic startAudio — may succeed if the join was triggered by a
  // recent user gesture. If not, the AudioPlaybackStatusChanged handler
  // will register a click-to-unlock fallback.
  localRoom.startAudio().catch(() => {
    log.debug("Optimistic startAudio failed — waiting for user gesture");
  });
}

/** A thrown connect/setup failure. */
export function onConnectFailed(
  host: JoinHost,
  err: unknown,
  resolvedUrl: string,
  localRoom: VoiceRoom | null,
  channelId: number,
  myGeneration: number,
  traceId: number,
): void {
  log.error("Failed to connect to LiveKit", { url: redactTunnelUrl(resolvedUrl), error: err });
  // SRE-M2: a thrown connect/setup failure is placed at the stage the
  // attempt last reached (resolve / connect / activate) — but only while
  // this attempt still owns the session (connecting with its generation,
  // or connected with its room). A superseded attempt that happened to
  // throw is churn, not a failure, and is abandoned in the finally below.
  if (
    ownsConnectAttempt(host, myGeneration) ||
    (localRoom !== null && isStateConnected(host, channelId, localRoom))
  ) {
    failJoinAttempt(traceId);
    const s = host.getState();
    if (s.type !== "connecting" || s.pendingJoin === null) {
      noteJoinFailed();
    }
  }
  if (localRoom !== null) {
    // Drop this attempt's listeners BEFORE disconnecting: handleDisconnected
    // acts on the shared session state, so a failed attempt's Disconnected
    // event would otherwise tear down (or spawn a reconnect loop for)
    // whichever session owns `_state` by then — which, when this attempt
    // has been superseded, is a live one that belongs to a newer join.
    try {
      void releaseRoom(localRoom);
    } catch (disconnectErr) {
      log.debug("Room disconnect during error cleanup failed (safe to ignore)", disconnectErr);
    }
    host.getOnError()?.(voiceText("join.connectionError"));
  }
  // Only touch the shared session state if this attempt is still current.
  // A superseded attempt must not clear a newer join's server-side voice
  // membership — leaveVoice's voice_leave frame carries no channel id and
  // acts on whichever channel the user currently occupies, so sending it
  // here for a stale attempt would delete the NEW join's voice_states row
  // — nor reset a live session back to idle (CLAUDE.md: voice sessions are
  // superseded, not cancelled).
  if (ownsConnectAttempt(host, myGeneration) && !hasQueuedJoin(host)) {
    // The connect attempt failed entirely: no SFU participant was ever
    // created, so no LiveKit webhook will ever clean up, and the server
    // already registered the join when it sent voice_token. Send
    // voice_leave and leave the store's voice channel (mirroring the
    // e2ee-timeout and reconnect-exhausted give-up paths) or the stale
    // voice_states row ghosts forever and can wedge the channel's
    // key-holder election.
    host.leaveVoice(true, false);
    leaveVoiceChannel();
  }
}
