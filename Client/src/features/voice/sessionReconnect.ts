// The session's reconnect handling: the room-event handlers that turn a
// dropped room into a reconnecting state, the auto-reconnect loop's host, and
// restoring what the drop stopped once the reconnect (or its rejoin) lands.
import {
  voiceStore,
  leaveVoiceChannel,
  setVoiceStatus,
  setLocalCamera,
  setLocalScreenshare,
} from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { authStore } from "@stores/auth.store";
import type { AudioElements } from "@lib/voice/audioElements";
import { attemptAutoReconnect } from "@lib/voice/livekitReconnect";
import { type RoomEventHandlers, createRoomEventHandlers } from "@lib/voice/roomEventHandlers";
import {
  type CameraTrackState,
  bumpGeneration,
  stopManualCameraTrack,
  stopManualScreenTracks,
} from "./screenShare";
import type { JoinOrchestration } from "./joinOrchestration";
import type { MusicShare, MusicStartOptions, MusicStartOutcome } from "./musicShare";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { isDmKeptForCall } from "../direct-messages/keptCallDms";
import { joinSequence, noteJoinSent } from "./joinRequest";
import { restoreMediaAfterReconnect } from "./localVoiceRestore";
import { isLinuxDesktop } from "./native/platform";
import { voiceText } from "../../i18n/voice";
import { SessionTokens } from "./sessionTokens";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

/** How long a session handed to a join waits for that join's answer. The
 *  server answers a voice_join in one round trip; past this it was lost. */
const YIELD_ANSWER_WAIT_MS = 15_000;

const log = createLogger("sessionReconnect");

export abstract class SessionReconnect extends SessionTokens {
  protected abstract readonly _join: JoinOrchestration;
  protected abstract readonly _audioElements: AudioElements;
  protected abstract readonly _cameraState: CameraTrackState;
  protected abstract _music: MusicShare | null;
  abstract startMusic(appId: string, options?: MusicStartOptions): Promise<MusicStartOutcome>;
  protected abstract createRoom(channelId?: number): Promise<VoiceRoom>;
  protected abstract syncModuleRooms(room?: VoiceRoom | null): void;
  protected abstract sweepPublications(room: VoiceRoom): void;
  protected abstract restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void>;
  abstract leaveVoice(sendWs?: boolean, keepWatched?: boolean): Promise<void>;

  protected createEventHandlers(): RoomEventHandlers {
    return createRoomEventHandlers({
      getRoom: () => this._room,
      setRoom: (r) => {
        // Called by handleDisconnected immediately before setReconnectAc.
        // Capture the reconnect fields from the current "connected" state
        // while we still have them, then clear the room (transition to idle).
        // setReconnectAc will pick up _pendingReconnectFields to form the
        // "reconnecting" state atomically.
        if (r === null && this._state.type === "connected") {
          this._pendingReconnectFields = {
            channelId: this._state.channelId,
            latestToken: this._state.latestToken,
            lastUrl: this._state.lastUrl,
            lastDirectUrl: this._state.lastDirectUrl,
          };
          this.setState({ type: "idle" });
        }
      },
      getCurrentChannelId: () => this._currentChannelId,
      getAudioElements: () => this._audioElements,
      getOnRemoteVideoCallback: () => this.onRemoteVideoCallback,
      getOnRemoteVideoRemovedCallback: () => this.onRemoteVideoRemovedCallback,
      isWatched: (userId, isScreenshare) =>
        this._remoteTracks.isWatched(userId, isScreenshare ? "screenshare" : "camera"),
      getOnErrorCallback: () => this.onErrorCallback,
      isConnecting: () => this._connecting,
      isReconnecting: () => this._state.type === "reconnecting",
      getLatestToken: () => this._latestToken,
      getLastUrl: () => this._lastUrl,
      getLastDirectUrl: () => this._lastDirectUrl,
      isNativeRoom: isLinuxDesktop,
      setReconnectAc: (ac) => {
        if (ac !== null && this._pendingReconnectFields !== null) {
          // Transition from idle → reconnecting atomically using the fields
          // captured in setRoom() above.
          const { channelId, latestToken, lastUrl, lastDirectUrl } = this._pendingReconnectFields;
          this._pendingReconnectFields = null;
          this.setState({
            type: "reconnecting",
            channelId,
            latestToken,
            lastUrl,
            lastDirectUrl,
            ac,
          });
          // A join already sent for another channel keeps its "joining": its
          // refusal is only rolled back under that status, and the loop about
          // to start stands down for it.
          if (!this.joinInFlightElsewhere(channelId)) setVoiceStatus("reconnecting");
        }
        // ac === null: reconnect succeeded — connectAndSetup already set "connected".
        // No transition needed; just discard stale pending fields if any.
        if (ac === null) {
          this._pendingReconnectFields = null;
        }
      },
      syncModuleRooms: () => this.syncModuleRooms(),
      teardownForReconnect: () => {
        this.pendingMicrophoneRoom = null;
        this._audioPipeline.teardownAudioPipeline();
        this.clearTokenRefreshTimer();
        // The WS session is independent of the LiveKit drop, so tell the
        // server the camera/screenshare are off before the local tracks are
        // stopped below — otherwise a successful reconnect leaves the
        // server's voice_states row at camera=1/screenshare=1 forever (no
        // webhook clears a reconnected, non-rogue participant), occupying a
        // max_video slot the user can never free.
        const { localCamera, localScreenshare } = voiceStore.getState();
        // Merged: a second drop before the first reconnect lands finds both
        // already off, and must not erase what the first drop stopped.
        const prev = this._lostOnReconnect;
        this._lostOnReconnect = {
          camera: localCamera || (prev?.camera ?? false),
          screenshare: localScreenshare || (prev?.screenshare ?? false),
        };
        if (this.ws !== null) {
          if (localCamera) {
            this.ws.send({ type: "voice_camera", payload: { enabled: false } });
          }
          if (localScreenshare) {
            this.ws.send({ type: "voice_screenshare", payload: { enabled: false } });
          }
        }
        // Bump first, mirroring doDisableCamera/doDisableScreenshare
        // — a concurrent enableCamera()/enableScreenshare() still awaiting
        // device acquisition (getUserMedia/getDisplayMedia/publishTrack) when
        // an unexpected disconnect fires must detect it was superseded and
        // discard its track instead of publishing onto the room about to be
        // torn down for auto-reconnect.
        bumpGeneration(this._cameraState);
        bumpGeneration(this._screenState);
        this._media.stopCodecSwitch();
        // Stop leaked camera/screen tracks before room is nulled.
        stopManualCameraTrack(this._cameraState, this._room);
        stopManualScreenTracks(this._screenState, this._room);
        // The music share is stopped with the room and shared again after
        // the reconnect, by the same app.
        // A start still waiting on the host counts: a second drop during the
        // restore keeps the app too.
        this._lostMusicApp = this._music?.appId ?? this._music?.pendingAppId ?? this._lostMusicApp;
        this._music?.stop();
        setLocalCamera(false);
        setLocalScreenshare(false);
      },
      leaveVoice: (sendWs) => this.leaveVoice(sendWs),
      applyMicMuteState: (muted) => this.applyMicMuteState(muted),
      setupAudioPipeline: () => this._audioPipeline.setupAudioPipeline(),
      attemptAutoReconnect: (token, url, channelId, directUrl, signal) =>
        this.attemptAutoReconnect(token, url, channelId, directUrl, signal),
    });
  }

  /** Attempt to auto-reconnect after unexpected disconnect using stored token.
   *  The signal is aborted by leaveVoice() to cancel the loop when the user
   *  voluntarily leaves voice during the reconnect delay. */
  protected async attemptAutoReconnect(
    token: string,
    url: string,
    channelId: number,
    directUrl: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    return attemptAutoReconnect(token, url, channelId, directUrl, signal, {
      getState: () => this._state,
      setState: (s) => this.setState(s),
      syncModuleRooms: () => this.syncModuleRooms(),
      setModuleRooms: (room) => this.syncModuleRooms(room),
      createRoom: () => this.createRoom(channelId),
      resolveUrl: (p, d) => this.resolveLiveKitUrl(p, d),
      reannounceE2EE: () => this._e2ee.reannounceForReconnect(),
      restoreLocalVoiceState: (m) => this.restoreLocalVoiceState(m),
      startTokenRefreshTimer: () => this.startTokenRefreshTimer(),
      requestTokenRefresh: () => this.requestTokenRefresh(),
      refreshTokenAndWait: () => this.refreshTokenAndWait(),
      tokenAgeMs: () => Date.now() - this._tokenReceivedAt,
      canKeepRetrying: () =>
        this.ws !== null &&
        this.ws.getState() !== "disconnected" &&
        (channelsStore.getState().channels.has(channelId) ||
          dmStore.getState().channels.some((dm) => dm.channelId === channelId) ||
          isDmKeptForCall(channelId)),
      serverMembership: async () => {
        const ws = this.ws;
        if (ws?.getState() !== "connected") return "unknown";
        // The socket reads "connected" from its auth_ok, before its ready or
        // resume replay restates the roster: a stale "held" would reconnect
        // to a call the server already ended. The server sends both before
        // it answers a ping, so a pong means the roster is current. A ping the
        // server drops (2/s per user) times out as "unknown": one attempt waits.
        // This also covers a call moved to another device while this socket was
        // away: registerNow queues voice_disconnected ahead of the pong, which
        // ends this session before the roster (which keeps the other device's
        // self row) is read.
        try {
          await ws.ping(signal);
        } catch {
          return "unknown";
        }
        if (this.ws !== ws || ws.getState() !== "connected") return "unknown";
        const self = authStore.getState().user?.id ?? 0;
        return voiceStore.getState().voiceUsers.get(channelId)?.has(self) === true
          ? "held"
          : "released";
      },
      rejoinVoice: () => {
        // The rejoin's join brings back what the drop stopped, as a reconnect does.
        const lost = this._lostOnReconnect;
        const lostMusic = this._lostMusicApp;
        void this.leaveVoice(false, true);
        this._lostOnReconnect = lost;
        this._lostMusicApp = lostMusic;
        this._rejoinPending = true;
        setVoiceStatus("joining");
        noteJoinSent(this.ws?.send({ type: "voice_join", payload: { channel_id: channelId } }));
      },
      leaveVoice: () => this.leaveVoice(this.ws?.getState() === "connected"),
      switchInFlight: () => this.joinInFlightElsewhere(channelId),
      yieldToSwitch: () => {
        void this.leaveVoice(false, true);
        this._yieldedToJoin = true;
        // leaveVoice wrote "idle"; the join's refusal is only rolled back
        // while the status reads "joining".
        setVoiceStatus("joining");
        this.armYieldWait(joinSequence());
      },
      sweepPublications: (room) => this.sweepPublications(room),
      onError: (msg) => this.onErrorCallback?.(msg),
      isStateConnected: (id, room) => this._join.isStateConnected(id, room),
      disconnectSupersededLocalRoom: (room) => this._join.disconnectSupersededLocalRoom(room),
      setupAudioPipeline: () => this._audioPipeline.setupAudioPipeline(),
      reapplyMuteGain: () => this.reapplyMuteGain(),
      clearPendingReconnectFields: () => {
        this._pendingReconnectFields = null;
      },
      noticeLostMedia: () => this.restoreLostMedia(),
    });
  }

  /** True while a join the user sent for a channel other than `channelId`
   *  waits for its answer. The store is where a click is recorded before its
   *  voice_join is answered (handleVoiceToken reads the same record). */
  private joinInFlightElsewhere(channelId: number): boolean {
    const { currentChannelId, voiceStatus } = voiceStore.getState();
    return voiceStatus === "joining" && currentChannelId !== null && currentChannelId !== channelId;
  }

  /** Bound the wait for the answer of join number `join`, the one the session
   *  was handed to. A token or a refusal clears the timer through
   *  clearYield(). With neither, the join was lost: the call ends the way a
   *  reconnect that gave up does, so the server drops whichever membership it
   *  still holds and the user can click again. */
  private armYieldWait(join: number): void {
    this._yieldTimer = setTimeout(() => {
      this._yieldTimer = null;
      const sent = joinSequence();
      const socket = this.ws?.getState();
      const socketSettled = socket === "connected" || socket === "disconnected";
      // A newer join has its own round trip to wait out, and a socket still
      // reconnecting can carry neither the answer nor the leave yet.
      if (sent !== join || (socket !== undefined && !socketSettled)) {
        this.armYieldWait(sent);
        return;
      }
      void this.leaveVoice(socket === "connected");
      leaveVoiceChannel();
      this.onErrorCallback?.(voiceText("reconnect.voiceLost"));
    }, YIELD_ANSWER_WAIT_MS);
  }

  /** Once a reconnect (or its rejoin) lands: bring back what the drop stopped. */
  protected restoreLostMedia(): void {
    const musicApp = this._lostMusicApp;
    this._lostMusicApp = null;
    if (musicApp !== null) void this.restoreMusic(musicApp);
    restoreMediaAfterReconnect({
      sendWatching: () => this.sendWatching(),
      getLost: () => this._lostOnReconnect,
      setLost: (lost) => {
        this._lostOnReconnect = lost;
      },
      room: () => this._room,
      stateType: () => this._state.type,
      enableCamera: () => this.enableCamera(),
      enableScreenshare: () => this.enableScreenshare(),
    });
  }

  /** Share the dropped music again; a refusal (the app is gone) ends it with a
   *  notice. A newer start or a stop meanwhile leaves it as it is. */
  private async restoreMusic(appId: string): Promise<void> {
    try {
      if ((await this.startMusic(appId, { quiet: true })) === "failed") {
        showToast(voiceText("music.lost"), "warning");
      }
    } catch (err) {
      showToast(voiceText("music.lost"), "warning");
      log.warn("Sharing the music again failed", err);
    }
  }

  /** A refused voice_join ends a reconnect's rejoin for good: tell the user
   *  the call was lost, as the loop's own give-up does. */
  failPendingRejoin(): void {
    if (!this._rejoinPending) return;
    this._rejoinPending = false;
    this._lostOnReconnect = null;
    this._lostMusicApp = null;
    this.onErrorCallback?.(voiceText("reconnect.voiceLost"));
  }
}
