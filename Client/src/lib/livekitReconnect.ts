// LiveKit auto-reconnect logic — extracted from livekitSession.ts.
// Owns the retry loop, supersession detection, and reconnect state transitions.

import { Room } from "livekit-client";
import { leaveVoiceChannel } from "@stores/voice.store";
import { loadPref } from "@lib/preferences";
import { createLogger } from "@lib/logger";
import { logIceConnectionInfo } from "@lib/livekitDiagnostics";
import { setJoinedVoiceStatus } from "@lib/roomEventHandlers";
import { releaseRoom } from "../features/voice/releaseRoom";
import { voiceText } from "../i18n/voice";

const log = createLogger("livekitReconnect");

export interface ReconnectDeps {
  /** Current session state accessor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- state shape is owned by LiveKitSession; reconnect only reads .type/.ac/.channelId
  getState: () => any;
  /** Transition to a new state. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as getState: the state shape is owned by LiveKitSession
  setState: (state: any) => void;
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
  /** True while the chat socket is connected and the channel still exists —
   *  the slow phase's precondition (P2-T5). */
  canKeepRetrying: () => boolean;
  /** Full session teardown, sending voice_leave to the server.
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
}

/** Auto-reconnect budget, sized to outlast a companion LiveKit restart.
 *
 *  RT-9: the companion SFU restarts with exponential backoff (3 s, doubling,
 *  up to 60 s in `Server/ws/livekit_process.go`) plus its own start-up, so a
 *  2-attempt, 3 s-apart loop (about 6 s) gave up while the SFU was still
 *  coming back and ejected every call. The first 5 attempts span about 27 s (a
 *  3 s-doubling backoff capped at 6 s), so they are still trying past a
 *  companion's 3 s + 6 s + 12 s restart ladder, and the 6 s cap keeps the
 *  retry gap small enough to resume the call promptly within the 30 s bar.
 *
 *  P2-T5 (DP-39, owner decision D-4): after those fast attempts the loop keeps
 *  trying every 15 s — a longer SFU restart or Wi-Fi drop resumes the call
 *  instead of ejecting the user — while the chat socket is connected and the
 *  channel still exists, and gives up 5 minutes after the drop. The ceiling
 *  bounds how long a dropped user stays in everyone's voice roster. The status
 *  badge shows "Reconnecting voice…" for the whole window. */
const FAST_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 6000;
const SLOW_RECONNECT_DELAY_MS = 15_000;
const RECONNECT_CEILING_MS = 5 * 60_000;

/** OC-0014: the server's token TTL is 5 minutes, so a token older than this
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
  state: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): boolean {
  return (
    signal.aborted ||
    state.type !== "reconnecting" ||
    (state.type === "reconnecting" && state.channelId !== channelId) ||
    (state.type === "reconnecting" && state.ac !== owner)
  );
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
  const superseded = () => reconnectSuperseded(signal, channelId, owner, deps.getState());
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    const slow = attempt > FAST_RECONNECT_ATTEMPTS;
    const delay = reconnectDelayMs(attempt);
    if (slow) {
      // D-4: no attempt starts past the ceiling, and none waits on a chat
      // socket or channel that is already gone.
      if (Date.now() - startedAt + delay > RECONNECT_CEILING_MS || !deps.canKeepRetrying()) break;
      // OC-0014: the attempt after this delay must carry a live token.
      if (deps.tokenAgeMs() + delay > TOKEN_REFRESH_AGE_MS) {
        // oxlint-disable-next-line no-await-in-loop -- the attempt must wait for the fresh token it connects with
        await deps.refreshTokenAndWait();
      }
    }
    log.info("Auto-reconnect attempt", { attempt });
    // RT-9: exponential backoff so the loop outlasts a companion restart.
    // oxlint-disable-next-line no-await-in-loop -- intentional sequential polling with backoff delay
    await new Promise((r) => setTimeout(r, delay));
    // If user manually left or joined a different channel during the delay, abort.
    if (superseded()) {
      log.info("Auto-reconnect aborted — user left or channel changed");
      return;
    }
    if (slow && !deps.canKeepRetrying()) break;
    // The state carries any token refreshed since the drop; superseded() just
    // confirmed it is still this loop's "reconnecting" state.
    const token: string = deps.getState().latestToken ?? initialToken;
    // Aliased outside the try so the catch can tear down the attempt's own
    // room: deps.getState() has no room while state is "reconnecting".
    let attemptRoom: Room | null = null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must create+arm E2EE before connect
      const newRoom = await deps.createRoom();
      attemptRoom = newRoom;
      const cleanupAbortedReconnect = async (): Promise<void> => {
        try {
          await releaseRoom(newRoom);
        } catch (disconnectErr) {
          log.warn("Failed to disconnect room after reconnect abort", disconnectErr);
        }
        // Re-sync from the CURRENT shared state instead of unconditionally
        // nulling: by the time this runs, a newer attempt may already own
        // `_state` (and its room), and this attempt's own room is never the
        // one referenced there (we are aborting before reaching "connected").
        const current = deps.getState();
        if (!superseded() || current.type === "idle" || current.type === "connected")
          deps.syncModuleRooms();
      };
      if (superseded()) {
        log.info("Auto-reconnect aborted after room creation");
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: the aborted attempt tears down its own room before returning
        await cleanupAbortedReconnect();
        return;
      }
      // Set state to reconnecting with the fresh room-less attempt info;
      // the actual room appears in "connected" state after connect succeeds.
      const current = deps.getState();
      if (current.type === "reconnecting") {
        deps.setState({ ...current, ac: current.ac });
      }
      deps.setModuleRooms(newRoom);

      // Through deps.resolveUrl, not the resolver directly: the original went
      // via LiveKitSession.resolveLiveKitUrl(), so anything that lands there
      // later must apply to the reconnect path too.
      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: resolve URL then connect
      const resolvedUrl = await deps.resolveUrl(url, directUrl);

      if (superseded()) {
        log.info("Auto-reconnect aborted before room connect");
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: the aborted attempt tears down its own room before returning
        await cleanupAbortedReconnect();
        return;
      }

      // E2EE: Regenerate ECDH keypair for the new session (forward secrecy)
      // and re-announce so other participants can re-wrap the room key for us.
      // oxlint-disable-next-line no-await-in-loop -- must set up E2EE before connect
      await deps.reannounceE2EE();

      if (superseded()) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: the aborted attempt tears down its own room before returning
        await cleanupAbortedReconnect();
        return;
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must connect before restoring state
      await newRoom.connect(resolvedUrl, token);

      if (superseded()) {
        log.info("Auto-reconnect aborted after room connect");
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: the aborted attempt tears down its own room before returning
        await cleanupAbortedReconnect();
        return;
      }

      log.info("Auto-reconnect succeeded", { attempt, channelId, url: resolvedUrl });
      // Transition to "connected" — this is the single atomic write.
      deps.setState({
        type: "connected",
        room: newRoom,
        channelId,
        latestToken: token,
        lastUrl: url,
        lastDirectUrl: directUrl,
      });
      setJoinedVoiceStatus(newRoom);
      logIceConnectionInfo(newRoom);
      newRoom.startAudio().catch((err) => log.debug("Failed to start audio after reconnect", err));
      // RT-6: the saved input goes in before the mic is re-captured, as on
      // the join path (joinOrchestration), so the reconnect opens it once.
      const savedInput = loadPref<string>("audioInputDevice", "");
      if (savedInput) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential by design: the device switch must land before the next superseded check
          await newRoom.switchActiveDevice("audioinput", savedInput, false);
        } catch (err) {
          log.warn("Reconnect: saved input device unavailable, using default", err);
        }
      }
      if (!deps.isStateConnected(channelId, newRoom)) {
        log.info("Auto-reconnect: superseded after audioinput switch — aborting tail", {
          channelId,
        });
        deps.disconnectSupersededLocalRoom(newRoom);
        return;
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must restore voice state after connect
      await deps.restoreLocalVoiceState("reconnect");

      // OC-0009: mirrors connectAndSetup's post-connect checkpoints. This tail
      // keeps awaiting AFTER it has already installed "connected" into the
      // shared state, so superseded() — which expects "reconnecting" — can no
      // longer tell a still-current attempt from a superseded one. A newer join
      // may have claimed the state for a different channel meanwhile, so each
      // await below is followed by an isStateConnected() checkpoint that reads
      // the live value. Without them a stale tail re-arms the shared token timer
      // and sends a refresh against somebody else's session.
      if (!deps.isStateConnected(channelId, newRoom)) {
        log.info("Auto-reconnect: superseded after restoreLocalVoiceState — aborting tail", {
          channelId,
        });
        deps.disconnectSupersededLocalRoom(newRoom);
        return;
      }

      // BUG-099: Reapply the saved output device after reconnect (matches initial join path;
      // the saved input went in above, before the mic was re-captured).
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential by design: the device switch must land before the next superseded check
          await newRoom.switchActiveDevice("audiooutput", savedOutput);
        } catch (err) {
          log.warn("Reconnect: saved output device unavailable, using default", err);
        }
      }

      if (!deps.isStateConnected(channelId, newRoom)) {
        log.info("Auto-reconnect: superseded after audiooutput switch — aborting tail", {
          channelId,
        });
        deps.disconnectSupersededLocalRoom(newRoom);
        return;
      }

      deps.setupAudioPipeline();
      deps.reapplyMuteGain();
      deps.startTokenRefreshTimer();
      // Signal the setReconnectAc callback that the reconnect is done.
      deps.clearPendingReconnectFields();
      // Request a fresh token since the stored one may be close to expiry.
      deps.requestTokenRefresh();
      return;
    } catch (err) {
      log.warn("Auto-reconnect failed", { attempt, url, error: err });
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
      const current = deps.getState();
      if (current.type === "reconnecting") {
        deps.setState({ ...current });
      }
      // See the matching comment in cleanupAbortedReconnect above: sync from
      // the current shared state rather than unconditionally nulling, so a
      // stale failed attempt cannot clobber a newer session's module wiring.
      if (!superseded() || current.type === "idle" || current.type === "connected")
        deps.syncModuleRooms();
    }
  }
  // Out of time (D-4), or the chat socket or channel is gone — give up and
  // clean up. But first check this loop is still current (see OC-0009 in
  // connectAndSetup).
  if (superseded()) {
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
