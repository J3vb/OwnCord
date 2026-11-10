// The session's reconnect handling: the room-event handlers that turn a
// dropped room into a reconnecting state, the auto-reconnect loop's host, and
// restoring what the drop stopped once the reconnect (or its rejoin) lands.
import type { Room } from "livekit-client";
import {
  voiceStore,
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
import { isDmKeptForCall } from "../direct-messages/keptCallDms";
import { noteJoinSent } from "./joinRequest";
import { restoreMediaAfterReconnect } from "./localVoiceRestore";
import { isLinuxDesktop } from "./native/platform";
import { voiceText } from "../../i18n/voice";
import { SessionTokens } from "./sessionTokens";

export abstract class SessionReconnect extends SessionTokens {
  protected abstract readonly _join: JoinOrchestration;
  protected abstract readonly _audioElements: AudioElements;
  protected abstract readonly _cameraState: CameraTrackState;
  protected abstract createRoom(channelId?: number): Promise<Room>;
  protected abstract syncModuleRooms(room?: Room | null): void;
  protected abstract sweepPublications(room: Room): void;
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
          setVoiceStatus("reconnecting");
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
        void this.leaveVoice(false, true);
        this._lostOnReconnect = lost;
        this._rejoinPending = true;
        setVoiceStatus("joining");
        noteJoinSent(this.ws?.send({ type: "voice_join", payload: { channel_id: channelId } }));
      },
      leaveVoice: () => this.leaveVoice(this.ws?.getState() === "connected"),
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

  /** Once a reconnect (or its rejoin) lands: bring back what the drop stopped. */
  protected restoreLostMedia(): void {
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

  /** A refused voice_join ends a reconnect's rejoin for good: tell the user
   *  the call was lost, as the loop's own give-up does. */
  failPendingRejoin(): void {
    if (!this._rejoinPending) return;
    this._rejoinPending = false;
    this._lostOnReconnect = null;
    this.onErrorCallback?.(voiceText("reconnect.voiceLost"));
  }
}
