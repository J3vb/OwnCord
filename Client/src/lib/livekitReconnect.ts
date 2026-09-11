// LiveKit auto-reconnect logic — extracted from livekitSession.ts.
// Owns the retry loop, supersession detection, and reconnect state transitions.

import { Room } from "livekit-client";
import { leaveVoiceChannel, setVoiceStatus } from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { logIceConnectionInfo } from "@lib/livekitDiagnostics";
import type { LiveKitUrlResolver } from "@lib/livekitUrlResolver";

const log = createLogger("livekitReconnect");

export interface ReconnectDeps {
  /** Current session state accessor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- state shape is owned by LiveKitSession; reconnect only reads .type/.ac/.channelId
  getState: () => any;
  /** Transition to a new state. */
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
  /** Send a WS frame. */
  sendWs: (msg: { type: string; payload: unknown }) => void;
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

/** Max auto-reconnect attempts before giving up and showing error. */
const MAX_RECONNECT_ATTEMPTS = 2;
const RECONNECT_DELAY_MS = 3000;

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
  token: string,
  url: string,
  channelId: number,
  directUrl: string | undefined,
  signal: AbortSignal,
  deps: ReconnectDeps,
  urlResolver: LiveKitUrlResolver,
): Promise<void> {
  const state = deps.getState();
  const owner = state.type === "reconnecting" ? state.ac : null;
  const superseded = () => reconnectSuperseded(signal, channelId, owner, deps.getState());

  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
    log.info("Auto-reconnect attempt", {
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    });
    // oxlint-disable-next-line no-await-in-loop -- intentional sequential polling with backoff delay
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    // If user manually left or joined a different channel during the delay, abort.
    if (superseded()) {
      log.info("Auto-reconnect aborted — user left or channel changed");
      return;
    }
    // Aliased outside the try so the catch can tear down the attempt's own
    // room: deps.getState() has no room while state is "reconnecting".
    let attemptRoom: Room | null = null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must create+arm E2EE before connect
      const newRoom = await deps.createRoom();
      attemptRoom = newRoom;
      const cleanupAbortedReconnect = async (): Promise<void> => {
        newRoom.removeAllListeners();
        try {
          await newRoom.disconnect();
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

      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: resolve URL then connect
      const resolvedUrl = await urlResolver.resolve(url, directUrl);

      if (superseded()) {
        log.info("Auto-reconnect aborted before room connect");
        await cleanupAbortedReconnect();
        return;
      }

      // E2EE: Regenerate ECDH keypair for the new session (forward secrecy)
      // and re-announce so other participants can re-wrap the room key for us.
      // oxlint-disable-next-line no-await-in-loop -- must set up E2EE before connect
      await deps.reannounceE2EE();

      if (superseded()) {
        await cleanupAbortedReconnect();
        return;
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must connect before restoring state
      await newRoom.connect(resolvedUrl, token);

      if (superseded()) {
        log.info("Auto-reconnect aborted after room connect");
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
      setVoiceStatus("connected");
      logIceConnectionInfo(newRoom);
      newRoom.startAudio().catch((err) => log.debug("Failed to start audio after reconnect", err));
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

      // BUG-099: Reapply saved audio devices after reconnect (matches initial join path).
      const savedInput = loadPref<string>("audioInputDevice", "");
      if (savedInput) {
        try {
          await newRoom.switchActiveDevice("audioinput", savedInput);
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

      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput) {
        try {
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
        attemptRoom.removeAllListeners();
        attemptRoom
          .disconnect()
          .catch((disconnectErr) =>
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
  // All attempts exhausted — give up and clean up. But first check this
  // loop is still current (see OC-0009 in connectAndSetup).
  if (superseded()) {
    log.info("Auto-reconnect give-up skipped — superseded");
    return;
  }
  // Send voice_leave over WS so the server removes our voice state;
  // without this the server and other clients see us as a ghost participant.
  log.error("Auto-reconnect exhausted all attempts, giving up");
  deps.sendWs({ type: "voice_leave", payload: {} });
  leaveVoiceChannel();
  deps.onError("Voice connection lost — failed to reconnect");
}
