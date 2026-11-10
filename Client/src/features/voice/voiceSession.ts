// The LiveKit session class behind lib/voice/livekitSession.ts: one instance
// owns the voice connection lifecycle and wires the join, room lifecycle and
// media modules together. lib/voice/livekitSession.ts creates the singleton
// and exports its bound methods.
//
// The class is the top of a chain of layers, one concern each, so no file
// outgrows its limit: sessionCore (state and accessors), sessionRemote (remote
// video and watching), sessionShare (share diagnostics), sessionMedia (media
// and device control), sessionE2ee (encryption), sessionTokens (token refresh
// and URLs) and sessionReconnect (the reconnect handling). The modules they
// delegate to are constructed here, with the hosts that give each its view of
// the session.
import { type Room, Track } from "livekit-client";
import type { WsClient } from "@lib/ws";
import { restateSelfVoiceState, isPttPollingLive, setLocalGateSpeaking } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { AudioPipeline } from "@lib/voice/audioPipeline";
import { AudioElements } from "@lib/voice/audioElements";
import { E2EEManager } from "@lib/voice/livekitE2EE";
import { DeviceManager } from "@lib/voice/deviceManager";
import { type CameraTrackState, type ScreenTrackState } from "./screenShare";
import { buildSessionDebugInfo } from "@lib/voice/livekitDiagnostics";
import type { RoomEventHandlers } from "@lib/voice/roomEventHandlers";
import { getShareMotionPolicy } from "@lib/voice/shareFlags";
import { JoinOrchestration } from "./joinOrchestration";
import { RoomLifecycle } from "./roomLifecycle";
import { MediaControl } from "./mediaControl";
import { restoreLocalVoiceState } from "./localVoiceRestore";
import { dismissMediaLostNotice } from "./mediaLostNotice";
import { isLinuxDesktop } from "./native/platform";
import { nativeCounters } from "./native/counters";
import { speechDetectionOf } from "./sileroDetection";
import { desktop } from "../../platform/desktop";
import { SessionReconnect } from "./sessionReconnect";

const log = createLogger("livekitSession");

// --- LiveKitSession class ---

export class LiveKitSession extends SessionReconnect {
  // ── Client-side E2EE (ECDH key exchange) — extracted to E2EEManager ──────
  /** Owns all E2EE state and the key-exchange protocol: ECDH keypair, room-key
   *  generation/rotation, identity signing / TOFU verification (F3), and the
   *  announce/offer handlers. See livekitE2EE.ts. */
  protected _e2ee = new E2EEManager({
    getWs: () => this.ws,
    getServerHost: () => this.serverHost,
    getCurrentChannelId: () => this._currentChannelId,
    onRoomKeyInstalled: () => this._eventHandlers.noteRoomKeyInstalled(),
  });

  // --- Extracted modules (facade pattern) ---
  /** Session-attempt ownership: connect, supersession checkpoints, join drain. */
  protected _join = new JoinOrchestration({
    getState: () => this._state,
    setState: (s) => this.setState(s),
    nextJoinGeneration: () => ++this._joinGenerationCounter,
    getRoom: () => this._room,
    getE2EE: () => this._e2ee,
    getAudioPipeline: () => this._audioPipeline,
    getAudioElements: () => this._audioElements,
    getDeviceManager: () => this._deviceManager,
    getOnError: () => this.onErrorCallback,
    createRoom: (channelId) => this.createRoom(channelId),
    resolveLiveKitUrl: (p, d) => this.resolveLiveKitUrl(p, d),
    restoreLocalVoiceState: (mode) => this.restoreLocalVoiceState(mode),
    reapplyMuteGain: () => this.reapplyMuteGain(),
    restateSelfVoiceState: () => {
      if (this.ws !== null) restateSelfVoiceState(this.ws);
      // The server holds no watch set for a fresh join: tell it ours.
      this.sendWatching(undefined, true);
    },
    startTokenRefreshTimer: () => this.startTokenRefreshTimer(),
    syncModuleRooms: () => this.syncModuleRooms(),
    leaveVoice: (sendWs, keepWatched) => this.leaveVoice(sendWs, keepWatched),
    sweepPublications: (room) => this.sweepPublications(room),
    handleVoiceTokenRefresh: (token) => this.handleVoiceTokenRefresh(token),
    connectAndSetup: (t, u, c, d, k) => this.connectAndSetup(t, u, c, d, k),
  });
  /** Room ownership: build, module wiring, E2EE worker, leave teardown. */
  protected _lifecycle = new RoomLifecycle({
    getState: () => this._state,
    setState: (s) => this.setState(s),
    getRoom: () => this._room,
    getWs: () => this.ws,
    getOnError: () => this.onErrorCallback,
    getE2EE: () => this._e2ee,
    getEventHandlers: () => this._eventHandlers,
    getAudioPipeline: () => this._audioPipeline,
    getAudioElements: () => this._audioElements,
    getDeviceManager: () => this._deviceManager,
    getTokenManager: () => this._tokenManager,
    getCameraState: () => this._cameraState,
    getScreenState: () => this._screenState,
    getPendingMicrophoneRoom: () => this.pendingMicrophoneRoom,
    setPendingMicrophoneRoom: (room) => {
      this.pendingMicrophoneRoom = room;
    },
    clearPendingReconnectFields: () => {
      this._pendingReconnectFields = null;
    },
    clearTokenRefreshTimer: () => this.clearTokenRefreshTimer(),
    configuredAudioOptions: (channelId) => this.configuredAudioOptions(channelId),
    microphonePublishingAllowed: (room) => this._media.microphonePublishingAllowed(room),
    applyMicMuteState: (muted) => this.applyMicMuteState(muted),
    dropDeniedVideo: (room) => this._media.dropDeniedVideo(room),
  });
  /** Mute/deafen policy, mic publishing, camera/screenshare/device/volume control. */
  protected _media = new MediaControl({
    getRoom: () => this._room,
    getCurrentChannelId: () => this._currentChannelId,
    getWs: () => this.ws,
    getOnError: () => this.onErrorCallback,
    getAudioPipeline: () => this._audioPipeline,
    getAudioElements: () => this._audioElements,
    getDeviceManager: () => this._deviceManager,
    getCameraState: () => this._cameraState,
    getScreenState: () => this._screenState,
    getPendingMicrophoneRoom: () => this.pendingMicrophoneRoom,
    setPendingMicrophoneRoom: (room) => {
      this.pendingMicrophoneRoom = room;
    },
    configuredAudioOptions: (channelId) => this.configuredAudioOptions(channelId),
  });
  protected _audioPipeline = new AudioPipeline(isPttPollingLive, speechDetectionOf);
  protected _audioElements = new AudioElements();
  protected _deviceManager = new DeviceManager();
  protected _eventHandlers: RoomEventHandlers;

  /** Manually published local tracks (camera/screenshare) for explicit cleanup. */
  protected _cameraState: CameraTrackState = { manualCameraTrack: null };
  protected _screenState: ScreenTrackState = { manualScreenTracks: [] };

  constructor() {
    super();
    this._audioPipeline.onGateSpeaking = setLocalGateSpeaking;
    this._eventHandlers = this.createEventHandlers();
  }

  // --- Room lifecycle (delegated to RoomLifecycle) ---

  protected async createRoom(channelId?: number): Promise<Room> {
    this.startShareDiagnostics();
    return this._lifecycle.createRoom(channelId);
  }

  /** Update all extracted modules with a room reference. See RoomLifecycle. */
  protected syncModuleRooms(room: Room | null = this._room): void {
    this._lifecycle.syncModuleRooms(room);
  }

  // --- Volume helpers ---

  protected restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void> {
    return restoreLocalVoiceState(mode, {
      room: () => this._room,
      audioPipeline: this._audioPipeline,
      media: this._media,
      audioElements: this._audioElements,
      onError: (message) => this.onErrorCallback?.(message),
      applyMicMuteState: (muted) => this.applyMicMuteState(muted),
    });
  }

  // --- Public API ---

  setWsClient(client: WsClient): void {
    this.ws = client;
  }
  setServerHost(host: string): void {
    // Identity keys are host-scoped — drop the cached keypair when the host
    // changes so we never sign an announce with another host's identity key.
    if (host !== this.serverHost) {
      this._e2ee.clearIdentityKeyPair();
    }
    this.serverHost = host;
    this._urlResolver.setServerHost(host);
  }
  setOnError(cb: (message: string) => void): void {
    this.onErrorCallback = cb;
    this._deviceManager.setOnError(cb);
  }
  clearOnError(): void {
    this.onErrorCallback = null;
    this._deviceManager.setOnError(null);
  }
  /** Shared connect-with-retry + post-connect setup used by both the primary
   *  handleVoiceToken path and the pending-join drain loop. See JoinOrchestration. */
  protected async connectAndSetup(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<boolean | "superseded"> {
    return this._join.connectAndSetup(token, url, channelId, directUrl, isKeyHolder);
  }

  async handleVoiceToken(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<void> {
    const rejoin = this._rejoinPending;
    this._rejoinPending = false;
    await this._join.handleVoiceToken(token, url, channelId, directUrl, isKeyHolder);
    if (!rejoin) return;
    const s = this._state;
    if (s.type === "connected" && s.channelId === channelId) this.restoreLostMedia();
    else this._lostOnReconnect = null;
  }

  protected sweepPublications(room: Room): void {
    this._eventHandlers.handleConnected(room);
    this._remoteTracks.dropUnpublishedWatches();
    this._remoteTracks.removeUnpublishedTiles();
  }

  /** Resolves once the room's disconnect has completed (the native room's,
   *  once the host acknowledged it); never rejects. */
  leaveVoice(sendWs = true, keepWatched = false): Promise<void> {
    this._rejoinPending = false;
    this._lostOnReconnect = null;
    if (this._watchRetry !== null) clearTimeout(this._watchRetry);
    this._watchRetry = null;
    dismissMediaLostNotice();
    if (!keepWatched) {
      this._leavingVoice = true;
      try {
        this._remoteTracks.clearWatched();
      } finally {
        this._leavingVoice = false;
      }
    }
    this._media.stopCodecSwitch();
    this.stopShareDiagnostics();
    return this._lifecycle.leaveVoice(sendWs);
  }

  /** Stays on the facade: past leaveVoice(false) it only clears the session's
   *  own configuration fields, which the room lifecycle does not own. */
  cleanupAll(): void {
    void this.leaveVoice(false);
    // leaveVoice() already transitions state to "idle".
    // Clear non-connection fields (config / callbacks / infrastructure).
    this.onErrorCallback = null;
    this._remoteTracks.clearOnRemoteVideo();
    this.ws = null;
    this.serverHost = null;
    this._urlResolver.setServerHost(null);
    this._e2ee.clearIdentityKeyPair();
    // Stop the Rust-side TLS proxy (fire-and-forget).
    this._urlResolver.stopProxy();
  }

  getSessionDebugInfo(): Record<string, unknown> {
    const debug = buildSessionDebugInfo({
      room: this._room,
      currentChannelId: this._currentChannelId,
      outputVolumeMultiplier: this._audioElements.getOutputVolumeMultiplier(),
      audioPipeline: this._audioPipeline,
      audioElements: this._audioElements,
    });
    // Your share's sender stats, as the share's own tile last read them
    // (it polls while you share); each read also asks for a fresh sample.
    // Nothing from a share that has ended.
    const sharing =
      this._room?.localParticipant.getTrackPublication(Track.Source.ScreenShare) !== undefined;
    if (sharing) {
      this.getLocalScreenshareStats().catch((err: unknown) =>
        log.debug("share sender stats failed", err),
      );
    }
    if (!sharing) this._shareSender = null;
    const timeline = this._shareDiag?.snapshot();
    const info = {
      ...debug,
      screenShareSender: this._shareSender,
      screenShareTimeline: {
        samples: timeline?.samples.length ?? 0,
        dropped: timeline?.dropped ?? 0,
        policy: getShareMotionPolicy(),
      },
    };
    if (!isLinuxDesktop()) return info;
    // Native resources are countable through the facade. Each
    // read asks the backend for a fresh snapshot, which the next read reports.
    desktop.nativeVoice.debugInfo().then(
      (resources) => {
        nativeCounters.rust = resources;
      },
      (err) => log.warn("native debug info failed", err),
    );
    return { ...info, native: { ...nativeCounters } };
  }
}
