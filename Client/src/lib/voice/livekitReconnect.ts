// LiveKit auto-reconnect logic — extracted from livekitSession.ts.
// Owns the retry loop, supersession detection, and reconnect state transitions.

import { Room } from "livekit-client";
import { leaveVoiceChannel } from "@stores/voice.store";
import { loadPref } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";
import { logIceConnectionInfo } from "@lib/voice/livekitDiagnostics";
import { setJoinedVoiceStatus } from "@lib/voice/roomEventHandlers";
import { releaseRoom } from "../../features/voice/releaseRoom";
import { ROOM_CONNECT_OPTIONS, type SessionState } from "../../features/voice/sessionState";
import { voiceText } from "../../i18n/voice";
import { redactTunnelUrl } from "@lib/voice/voiceJoinTrace";

const log = createLogger("livekitReconnect");

export interface ReconnectDeps {
  sweepPublications(room: Room): void;
  /** Current session state accessor. */
  getState: () => SessionState;
  /** Transition to a new state. */
  setState: (state: SessionState) => void;
  /** Sync extracted modules (AudioPipeline, AudioElements, DeviceManager) to the room
   *  in the CURRENT shared state. Only correct where that state is the one to follow —
   *  the abort/failure paths. Mid-attempt, use setModuleRooms instead. */
  syncModuleRooms: () => void;
  /** Point the extracted modules at THIS attempt's room.
   *
   *  Not syncModuleRooms(): that reads the room out of the shared state, and at
   *  the point this is called the state is still "reconnecting", which is
   *  room-less. Syncing there wires every module to null, so the reconnect
   *  finishes with no audio pipeline and no remote-subscription handling —
   *  deafen silently stops being re-applied. */
  setModuleRooms: (room: Room) => void;
  /** Create a new Room with E2EE wired up. */
  createRoom: () => Promise<Room>;
  /** Resolve a LiveKit URL. */
  resolveUrl: (proxyPath: string, directUrl?: string) => Promise<string>;
  /** Re-announce E2EE for the new session (forward secrecy). */
  reannounceE2EE: () => Promise<void>;
  /** Restore local voice state (mic, deafen, PTT). */
  restoreLocalVoiceState: (mode: "join" | "reconnect") => Promise<void>;
  /** Start the token refresh timer. */
  startTokenRefreshTimer: () => void;
  /** Request a token refresh. */
  requestTokenRefresh: () => void;
  /** Request a token refresh and wait for the reply (bounded), so the next
   *  attempt reads the fresh token from the state. */
  refreshTokenAndWait: () => Promise<void>;
  /** Milliseconds since the current token arrived. */
  tokenAgeMs: () => number;
  /** True while the chat socket is connected or reconnecting (not closed for
   *  good: sign-out, session replaced, auth failure) and the channel still
   *  exists — every attempt's precondition (P2-T5). */
  canKeepRetrying: () => boolean;
  /** Whether the server still holds the membership the old token belongs to,
   *  read from the voice roster — "unknown" while the chat socket is not
   *  connected, since the roster cannot update then. Resolves only once the
   *  socket's own ready or resume replay is applied: a socket reads
   *  "connected" from its auth_ok, while the roster still shows the drop. */
  serverMembership: () => Promise<"held" | "released" | "unknown">;
  /** Tear the session down and send voice_join for the same channel, so the
   *  ordinary join path (E2EE, device prefs) resumes the call. Only called
   *  once serverMembership() reads "released". */
  rejoinVoice: () => void;
  /** Full session teardown, sending voice_leave to the server when the chat
   *  socket is connected (a socket still reconnecting cannot carry it; the
   *  server's grace window and reaper retire the membership instead).
   *
   *  Not a bare voice_leave frame: the give-up path is a real leave, so it owes
   *  the session everything leaveVoice(true) does — state back to "idle", the
   *  E2EE worker terminated so the last room key does not stay resident, timers
   *  cleared, and the FULL audio-element cleanup that also clears per-call
   *  screenshare mute/volume state (the reconnect-flavoured cleanup
   *  deliberately preserves it). Only ever called once the give-up path has
   *  confirmed it is not superseded — this teardown is global, so a superseded
   *  loop calling it would kill the live session that replaced it
   *  (Client/CLAUDE.md: voice sessions are superseded, not cancelled). */
  leaveVoice: () => void;
  /** Error callback. */
  onError: (message: string) => void;
  /** True when the shared state is still THIS attempt's connected room. */
  isStateConnected: (channelId: number, room: Room) => boolean;
  /** Tear down a room this attempt no longer owns. */
  disconnectSupersededLocalRoom: (room: Room) => void;
  /** Rebuild the audio pipeline against the new room. */
  setupAudioPipeline: () => void;
  /** Re-apply mute gain once the pipeline is rebuilt. */
  reapplyMuteGain: () => void;
  /** Clear the pending-reconnect fields now the tail has completed. */
  clearPendingReconnectFields: () => void;
  /** Tell the user about a camera or screen share the drop stopped. Only a
   *  reconnect that got all the way through calls it. */
  noticeLostMedia: () => void;
}

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

/** Refresh a token that would be stale by the next attempt, but only for a
 *  membership the server still holds. False when the loop was superseded. */
async function refreshStaleToken(run: ReconnectRun): Promise<boolean> {
  const { deps } = run;
  const held = (await deps.serverMembership()) === "held";
  if (run.superseded()) {
    logAborted();
    return false;
  }
  if (held) await deps.refreshTokenAndWait();
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
function judgeMembership(run: ReconnectRun, membership: "held" | "released" | "unknown"): Gate {
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
  if (!run.superseded() || current.type === "idle" || current.type === "connected") {
    run.deps.syncModuleRooms();
  }
}

/** Tear down this attempt's own room and return; never the global session. */
async function abortAttempt(run: ReconnectRun, room: Room): Promise<void> {
  try {
    await releaseRoom(room);
  } catch (disconnectErr) {
    log.warn("Failed to disconnect room after reconnect abort", disconnectErr);
  }
  resyncModulesIfSafe(run, run.deps.getState());
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
  room: Room,
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

async function switchSavedInput(room: Room, deviceId: string): Promise<void> {
  try {
    await room.switchActiveDevice("audioinput", deviceId, false);
  } catch (err) {
    log.warn("Reconnect: saved input device unavailable, using default", err);
  }
}

async function switchSavedOutput(room: Room, deviceId: string): Promise<void> {
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
async function finishConnectedTail(run: ReconnectRun, room: Room): Promise<void> {
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
  attemptRoom: Room | null,
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
  // Return to idle so the next attempt starts fresh.
  resyncModulesIfSafe(run, restateReconnecting(run.deps));
}

/** One connect attempt. True when the loop is finished (connected, or aborted
 *  and cleaned up), false when the attempt failed and the loop should go on.
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
  let attemptRoom: Room | null = null;
  try {
    const newRoom = await deps.createRoom();
    attemptRoom = newRoom;
    if (run.superseded()) {
      log.info("Auto-reconnect aborted after room creation");
      await abortAttempt(run, newRoom);
      return true;
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
      await abortAttempt(run, newRoom);
      return true;
    }

    // E2EE: Regenerate ECDH keypair for the new session (forward secrecy)
    // and re-announce so other participants can re-wrap the room key for us.
    await deps.reannounceE2EE();
    if (run.superseded()) {
      await abortAttempt(run, newRoom);
      return true;
    }

    await newRoom.connect(resolvedUrl, token, ROOM_CONNECT_OPTIONS);
    if (run.superseded()) {
      log.info("Auto-reconnect aborted after room connect");
      await abortAttempt(run, newRoom);
      return true;
    }

    installConnected(run, newRoom, token, attempt, resolvedUrl);
    await finishConnectedTail(run, newRoom);
    return true;
  } catch (err) {
    handleAttemptFailure(run, attempt, err, attemptRoom);
    return false;
  }
}

/** Out of time, or the chat socket closed for good or the channel is
 *  gone — give up and clean up. But first check this loop is still current
 *  (see connectAndSetup). */
function giveUpReconnect(run: ReconnectRun): void {
  const { deps } = run;
  if (run.superseded()) {
    log.info("Auto-reconnect give-up skipped — superseded");
    return;
  }
  // Tear the session down for real. leaveVoice(true) also sends voice_leave
  // over WS, so the server removes our voice state — without that the server
  // and other clients see us as a ghost participant.
  log.error("Auto-reconnect giving up");
  deps.leaveVoice();
  leaveVoiceChannel();
  deps.onError(voiceText("reconnect.voiceLost"));
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
  const run: ReconnectRun = {
    deps,
    initialToken,
    url,
    channelId,
    directUrl,
    startedAt: Date.now(),
    superseded: () => reconnectSuperseded(signal, channelId, owner, deps.getState()),
  };

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
    const verdict = judgeMembership(run, await deps.serverMembership());
    if (verdict === "stop") return;
    if (verdict === "retry") continue;
    // oxlint-disable-next-line no-await-in-loop -- sequential: one attempt at a time
    if (await runAttempt(run, attempt)) return;
  }
  giveUpReconnect(run);
}
