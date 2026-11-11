// LiveKit auto-reconnect logic — extracted from livekitSession.ts.
// Owns the retry loop, supersession detection, and reconnect state transitions.

import { leaveVoiceChannel } from "@stores/voice.store";
import { loadPref } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";
import { logIceConnectionInfo } from "@lib/voice/livekitDiagnostics";
import { setJoinedVoiceStatus } from "@lib/voice/roomEventHandlers";
import type { ReconnectDeps, ServerMembership } from "../../features/voice/reconnectDeps";
import { releaseRoom } from "../../features/voice/releaseRoom";
import { ROOM_CONNECT_OPTIONS, type SessionState } from "../../features/voice/sessionState";
import { voiceText } from "../../i18n/voice";
import { redactTunnelUrl } from "@lib/voice/voiceJoinTrace";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

const log = createLogger("livekitReconnect");

/** Auto-reconnect budget, sized to outlast a companion LiveKit restart.
 *
 *  The companion SFU restarts with exponential backoff (3 s, doubling,
 *  up to 60 s in `Server/ws/livekit_process.go`) plus its own start-up, so a
 *  2-attempt, 3 s-apart loop (about 6 s) gave up while the SFU was still
 *  coming back and ejected every call. The first 5 attempts span about 27 s (a
 *  3 s-doubling backoff capped at 6 s), so they are still trying past a
 *  companion's 3 s + 6 s + 12 s restart ladder, and the 6 s cap keeps the
 *  retry gap small enough to resume the call promptly within the 30 s bar.
 *
 *  After those fast attempts the loop keeps
 *  trying every 15 s — a longer SFU restart or Wi-Fi drop resumes the call
 *  instead of ejecting the user — while the chat socket is connected or
 *  reconnecting and the channel still exists, and gives up 5 minutes after the
 *  drop. The ceiling bounds how long a dropped user stays in everyone's voice
 *  roster. The status badge shows "Reconnecting voice…" for the whole window. */
const FAST_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 6000;
const SLOW_RECONNECT_DELAY_MS = 15_000;
const RECONNECT_CEILING_MS = 5 * 60_000;

/** The server's token TTL is 5 minutes, so a token older than this
 *  is refreshed before the next attempt rather than failing it. */
const TOKEN_REFRESH_AGE_MS = 4 * 60_000;

/** Delay before attempt `attempt` (1-based): 3 s, doubling, capped at 6 s,
 *  then 15 s once the fast attempts are spent. */
function reconnectDelayMs(attempt: number): number {
  if (attempt > FAST_RECONNECT_ATTEMPTS) return SLOW_RECONNECT_DELAY_MS;
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
}

/** True while an in-flight reconnect attempt has been superseded. */
function reconnectSuperseded(
  signal: AbortSignal,
  channelId: number,
  owner: AbortController | null,
  state: SessionState,
): boolean {
  return (
    signal.aborted ||
    state.type !== "reconnecting" ||
    state.channelId !== channelId ||
    state.ac !== owner
  );
}

/** What one reconnect loop carries from step to step. */
interface ReconnectRun {
  readonly deps: ReconnectDeps;
  readonly initialToken: string;
  readonly url: string;
  readonly channelId: number;
  readonly directUrl: string | undefined;
  readonly startedAt: number;
  /** The shared state is no longer this loop's: a newer owner, or a leave. */
  readonly displaced: () => boolean;
  /** Displaced, or standing down for a join the user sent for another channel. */
  readonly superseded: () => boolean;
}

/** Where a step leaves the loop: carry on, return, give up, or skip an attempt. */
type Gate = "go" | "stop" | "giveUp" | "retry" | "refresh";

function logAborted(): void {
  log.info("Auto-reconnect aborted — user left or channel changed");
}

/** Before a slow-phase wait. Synchronous on purpose: the caller starts its
 *  next await in the same tick as the checks. */
function slowPreflight(run: ReconnectRun, delay: number): Gate {
  const { deps } = run;
  // No attempt starts past the ceiling, and none waits on a chat
  // socket closed for good or a channel that is already gone.
  if (Date.now() - run.startedAt + delay > RECONNECT_CEILING_MS || !deps.canKeepRetrying()) {
    return "giveUp";
  }
  // A loop superseded by its failed attempt must not touch the shared token
  // waiter: that would spend the live session's refresh budget.
  if (run.superseded()) {
    logAborted();
    return "stop";
  }
  // The attempt after this delay must carry a live token.
  return deps.tokenAgeMs() + delay > TOKEN_REFRESH_AGE_MS ? "refresh" : "go";
}

/** Read the membership from the voice roster. A read that fails says nothing
 *  either way, so it counts as "unknown": the loop waits one attempt instead
 *  of ending with the session left in "reconnecting". */
async function readMembership(deps: ReconnectDeps): Promise<ServerMembership> {
  try {
    return await deps.serverMembership();
  } catch (err) {
    log.warn("Auto-reconnect: membership read failed — treating it as unknown", err);
    return "unknown";
  }
}

/** Refresh a token that would be stale by the next attempt, but only for a
 *  membership the server still holds. False when the loop was superseded. */
async function refreshStaleToken(run: ReconnectRun): Promise<boolean> {
  const { deps } = run;
  const held = (await readMembership(deps)) === "held";
  if (run.superseded()) {
    logAborted();
    return false;
  }
  try {
    if (held) await deps.refreshTokenAndWait();
  } catch (err) {
    // As when no reply arrives in time: the attempt runs with the token it has.
    log.warn("Auto-reconnect: token refresh failed — keeping the current token", err);
  }
  return true;
}

/** After the backoff wait. Synchronous: the roster read starts in the same tick. */
function afterBackoff(run: ReconnectRun): Gate {
  // If user manually left or joined a different channel during the delay, abort.
  if (run.superseded()) {
    logAborted();
    return "stop";
  }
  return run.deps.canKeepRetrying() ? "go" : "giveUp";
}

/** Judge the membership just read. Synchronous: on "go" the caller starts the
 *  attempt in the same tick as the supersession check.
 *
 *  The old token is only good for a membership the server still holds:
 *  wait out a chat socket that cannot say, and rejoin one it released
 *  (grace expiry, a server reap, a restart). */
function judgeMembership(run: ReconnectRun, membership: ServerMembership): Gate {
  if (run.superseded()) {
    logAborted();
    return "stop";
  }
  if (membership === "unknown") return "retry";
  if (membership === "released") {
    log.info("Auto-reconnect: server membership gone — rejoining", { channelId: run.channelId });
    run.deps.rejoinVoice();
    return "stop";
  }
  return "go";
}

/** Re-sync the extracted modules from the CURRENT shared state instead of
 *  unconditionally nulling: a newer attempt may already own `_state` (and its
 *  room), and this attempt's own room is never the one referenced there. */
function resyncModulesIfSafe(run: ReconnectRun, current: SessionState): void {
  if (!run.displaced() || current.type === "idle" || current.type === "connected") {
    run.deps.syncModuleRooms();
  }
}

/** Tear down this attempt's own room, never the global session. True when
 *  the loop is over. The release is a round trip, so it looks again after it:
 *  false when the join it stopped for is gone by then (the user clicked back),
 *  and the loop goes on as after a failed attempt. */
async function abortAttempt(run: ReconnectRun, room: VoiceRoom): Promise<boolean> {
  try {
    await releaseRoom(room);
  } catch (disconnectErr) {
    log.warn("Failed to disconnect room after reconnect abort", disconnectErr);
  }
  const over = run.superseded();
  if (!over) log.info("Auto-reconnect: the join it stopped for is gone — carrying on");
  resyncModulesIfSafe(run, over ? run.deps.getState() : restateReconnecting(run.deps));
  return over;
}

/** Re-state the room-less reconnecting attempt; returns the state it read. */
function restateReconnecting(deps: ReconnectDeps): SessionState {
  const current = deps.getState();
  if (current.type === "reconnecting") {
    deps.setState({ ...current });
  }
  return current;
}

/** Transition to "connected" — the single atomic write — and wire the new room. */
function installConnected(
  run: ReconnectRun,
  room: VoiceRoom,
  token: string,
  attempt: number,
  resolvedUrl: string,
): void {
  const { deps, channelId } = run;
  log.info("Auto-reconnect succeeded", {
    attempt,
    channelId,
    url: redactTunnelUrl(resolvedUrl),
  });
  deps.setState({
    type: "connected",
    room,
    channelId,
    latestToken: token,
    lastUrl: run.url,
    lastDirectUrl: run.directUrl,
  });
  setJoinedVoiceStatus(room);
  deps.sweepPublications(room);
  logIceConnectionInfo(room);
  room.startAudio().catch((err) => log.debug("Failed to start audio after reconnect", err));
}

async function switchSavedInput(room: VoiceRoom, deviceId: string): Promise<void> {
  try {
    await room.switchActiveDevice("audioinput", deviceId, false);
  } catch (err) {
    log.warn("Reconnect: saved input device unavailable, using default", err);
  }
}

async function switchSavedOutput(room: VoiceRoom, deviceId: string): Promise<void> {
  try {
    await room.switchActiveDevice("audiooutput", deviceId);
  } catch (err) {
    log.warn("Reconnect: saved output device unavailable, using default", err);
  }
}

/** Mirrors connectAndSetup's post-connect checkpoints. This tail keeps
 *  awaiting AFTER it has already installed "connected" into the shared state,
 *  so superseded() — which expects "reconnecting" — can no longer tell a
 *  still-current attempt from a superseded one. A newer join may have claimed
 *  the state for a different channel meanwhile, so each await below is
 *  followed by an isStateConnected() checkpoint that reads the live value.
 *  Without them a stale tail re-arms the shared token timer and sends a
 *  refresh against somebody else's session. */
async function finishConnectedTail(run: ReconnectRun, room: VoiceRoom): Promise<void> {
  const { deps, channelId } = run;
  // The saved input goes in before the mic is re-captured, as on
  // the join path (joinOrchestration), so the reconnect opens it once.
  const savedInput = loadPref<string>("audioInputDevice", "");
  if (savedInput) await switchSavedInput(room, savedInput);
  if (!deps.isStateConnected(channelId, room)) {
    log.info("Auto-reconnect: superseded after audioinput switch — aborting tail", { channelId });
    deps.disconnectSupersededLocalRoom(room);
    return;
  }

  await deps.restoreLocalVoiceState("reconnect");
  if (!deps.isStateConnected(channelId, room)) {
    log.info("Auto-reconnect: superseded after restoreLocalVoiceState — aborting tail", {
      channelId,
    });
    deps.disconnectSupersededLocalRoom(room);
    return;
  }

  // Reapply the saved output device after reconnect (matches initial join path;
  // the saved input went in above, before the mic was re-captured).
  const savedOutput = loadPref<string>("audioOutputDevice", "");
  if (savedOutput) await switchSavedOutput(room, savedOutput);
  if (!deps.isStateConnected(channelId, room)) {
    log.info("Auto-reconnect: superseded after audiooutput switch — aborting tail", { channelId });
    deps.disconnectSupersededLocalRoom(room);
    return;
  }

  deps.setupAudioPipeline();
  deps.reapplyMuteGain();
  deps.startTokenRefreshTimer();
  // Signal the setReconnectAc callback that the reconnect is done.
  deps.clearPendingReconnectFields();
  // Request a fresh token since the stored one may be close to expiry.
  deps.requestTokenRefresh();
  deps.noticeLostMedia();
}

/** A failed attempt: tear down its room, return to a fresh reconnecting
 *  state and re-wire the modules only when this loop is still current. */
function handleAttemptFailure(
  run: ReconnectRun,
  attempt: number,
  err: unknown,
  attemptRoom: VoiceRoom | null,
): void {
  log.warn("Auto-reconnect failed", { attempt, url: run.url, error: err });
  // Tear down this attempt's room (deps.getState() has no room in "reconnecting"
  // state) — a leaked room keeps its listeners, and its synchronous
  // Disconnected event would spawn a second, uncancellable reconnect
  // loop. null only if createRoom() itself threw.
  if (attemptRoom !== null) {
    releaseRoom(attemptRoom).catch((disconnectErr) =>
      log.warn("Failed to disconnect room after reconnect failure", disconnectErr),
    );
  }
  // Restate "reconnecting" so the next attempt starts fresh, but only as its
  // owner: a superseded attempt writes nothing into the shared state.
  const current = run.superseded() ? run.deps.getState() : restateReconnecting(run.deps);
  resyncModulesIfSafe(run, current);
}

/** Clear this loop's session out of the way of the join in flight. */
function handOver(deps: ReconnectDeps, channelId: number): void {
  log.info("Auto-reconnect: handing the session to the join in flight", { channelId });
  deps.yieldToSwitch();
}

/** Leave the call for real and tell the user. leaveVoice also sends voice_leave
 *  while the chat socket is connected, so the server removes our voice state —
 *  without that the server and other clients see us as a ghost participant.
 *
 *  Not while a join the user already sent for another channel waits for its
 *  answer: that voice_leave names no channel, so it would end the membership
 *  the join just made, and clearing the store would turn its token away. The
 *  loop then only clears its own session out of that join's way. */
function endCall(deps: ReconnectDeps, channelId: number): void {
  if (deps.switchInFlight()) {
    handOver(deps, channelId);
    return;
  }
  deps.leaveVoice();
  leaveVoiceChannel();
  deps.onError(voiceText("reconnect.voiceLost"));
}

/** A failure after this attempt made its room the session: "connected" is
 *  installed before the tail runs. Releasing only the room would leave the
 *  state "connected" on a room that is gone, and nothing here can put back
 *  "reconnecting" over what the tail already set up, so the call ends the way
 *  a give-up does. False when the state is no longer this attempt's connected
 *  room (a newer attempt owns it): the caller then cleans up its own room only. */
function endedAfterConnectedFailure(
  run: ReconnectRun,
  attempt: number,
  err: unknown,
  room: VoiceRoom,
): boolean {
  if (!run.deps.isStateConnected(run.channelId, room)) return false;
  log.error("Auto-reconnect failed after connecting — leaving voice", { attempt, error: err });
  endCall(run.deps, run.channelId);
  return true;
}

/** One connect attempt. True when the loop is finished (connected, aborted
 *  and cleaned up, or ended after a late failure), false when the attempt
 *  failed and the loop should go on.
 *  Every await is followed at once by its supersession checkpoint. */
async function runAttempt(run: ReconnectRun, attempt: number): Promise<boolean> {
  const { deps } = run;
  // The state carries any token refreshed since the drop; superseded() just
  // confirmed it is still this loop's "reconnecting" state.
  const state = deps.getState();
  const token: string =
    (state.type === "reconnecting" ? state.latestToken : undefined) ?? run.initialToken;
  // Aliased outside the try so the catch can tear down the attempt's own
  // room: deps.getState() has no room while state is "reconnecting".
  let attemptRoom: VoiceRoom | null = null;
  // The room this attempt wrote into the state as the connected session.
  let installedRoom: VoiceRoom | null = null;
  try {
    const newRoom = await deps.createRoom();
    attemptRoom = newRoom;
    if (run.superseded()) {
      log.info("Auto-reconnect aborted after room creation");
      return await abortAttempt(run, newRoom);
    }
    // Set state to reconnecting with the fresh room-less attempt info;
    // the actual room appears in "connected" state after connect succeeds.
    restateReconnecting(deps);
    deps.setModuleRooms(newRoom);

    // Through deps.resolveUrl, not the resolver directly: the original went
    // via LiveKitSession.resolveLiveKitUrl(), so anything that lands there
    // later must apply to the reconnect path too.
    const resolvedUrl = await deps.resolveUrl(run.url, run.directUrl);
    if (run.superseded()) {
      log.info("Auto-reconnect aborted before room connect");
      return await abortAttempt(run, newRoom);
    }

    // E2EE: Regenerate ECDH keypair for the new session (forward secrecy)
    // and re-announce so other participants can re-wrap the room key for us.
    await deps.reannounceE2EE();
    if (run.superseded()) {
      return await abortAttempt(run, newRoom);
    }

    await newRoom.connect(resolvedUrl, token, ROOM_CONNECT_OPTIONS);
    if (run.superseded()) {
      log.info("Auto-reconnect aborted after room connect");
      return await abortAttempt(run, newRoom);
    }

    installedRoom = newRoom;
    installConnected(run, newRoom, token, attempt, resolvedUrl);
    await finishConnectedTail(run, newRoom);
    return true;
  } catch (err) {
    if (installedRoom !== null && endedAfterConnectedFailure(run, attempt, err, installedRoom)) {
      return true;
    }
    handleAttemptFailure(run, attempt, err, attemptRoom);
    return false;
  }
}

/** Out of time, or the chat socket closed for good or the channel is
 *  gone — give up and clean up. But first check this loop is still current
 *  (see connectAndSetup). */
function giveUpReconnect(run: ReconnectRun): void {
  if (run.superseded()) {
    log.info("Auto-reconnect give-up skipped — superseded");
    return;
  }
  log.error("Auto-reconnect giving up");
  endCall(run.deps, run.channelId);
}

/** Attempt to auto-reconnect after unexpected disconnect using stored token.
 *  The signal is aborted by leaveVoice() to cancel the loop when the user
 *  voluntarily leaves voice during the reconnect delay. */
export async function attemptAutoReconnect(
  initialToken: string,
  url: string,
  channelId: number,
  directUrl: string | undefined,
  signal: AbortSignal,
  deps: ReconnectDeps,
): Promise<void> {
  const state = deps.getState();
  const owner = state.type === "reconnecting" ? state.ac : null;
  const displaced = (): boolean => reconnectSuperseded(signal, channelId, owner, deps.getState());
  // A join the user already sent for another channel supersedes the loop as a
  // newer owner does, before its answer has made it a session. The last look
  // says why the loop stopped: every stop returns straight after one.
  let standingDown = false;
  const run: ReconnectRun = {
    deps,
    initialToken,
    url,
    channelId,
    directUrl,
    startedAt: Date.now(),
    displaced,
    superseded: () => displaced() || (standingDown = deps.switchInFlight()),
  };
  await runReconnectLoop(run);
  // Stopped for a join that is not a session yet: the state is still this
  // loop's, so nothing else clears it out of that join's way.
  if (standingDown && !displaced()) handOver(deps, channelId);
}

/** The attempts, one after another, until one ends the loop or it gives up. */
async function runReconnectLoop(run: ReconnectRun): Promise<void> {
  const { deps } = run;
  for (let attempt = 1; ; attempt++) {
    const delay = reconnectDelayMs(attempt);
    if (attempt > FAST_RECONNECT_ATTEMPTS) {
      const pre = slowPreflight(run, delay);
      if (pre === "giveUp") break;
      if (pre === "stop") return;
      // oxlint-disable-next-line no-await-in-loop -- the attempt must wait for the fresh token it connects with
      if (pre === "refresh" && !(await refreshStaleToken(run))) return;
    }
    log.info("Auto-reconnect attempt", { attempt });
    // Exponential backoff so the loop outlasts a companion restart.
    // oxlint-disable-next-line no-await-in-loop -- intentional sequential polling with backoff delay
    await new Promise((r) => setTimeout(r, delay));
    const waited = afterBackoff(run);
    if (waited === "giveUp") break;
    if (waited === "stop") return;
    // oxlint-disable-next-line no-await-in-loop -- each attempt reads the roster as it is now
    const verdict = judgeMembership(run, await readMembership(deps));
    if (verdict === "stop") return;
    if (verdict === "retry") continue;
    // oxlint-disable-next-line no-await-in-loop -- sequential: one attempt at a time
    if (await runAttempt(run, attempt)) return;
  }
  giveUpReconnect(run);
}
