// The LiveKit session class behind lib/voice/livekitSession.ts: one instance
// owns the voice connection lifecycle and wires the join, room lifecycle and
// media modules together. lib/voice/livekitSession.ts creates the singleton
// and exports its bound methods.
import { type Room, Track } from "livekit-client";
import type { StreamSample, VideoView } from "./remoteTracks";
import type { ShareSenderSample } from "./shareSenderStats";
import {
  ShareDiagnosticsRecorder,
  type ShareDiagnosticsSnapshot,
} from "@lib/voice/shareDiagnostics";
import { getShareDiagnosticsEnabled, getShareMotionPolicy } from "@lib/voice/shareFlags";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  restateSelfVoiceState,
  isPttPollingLive,
  setLocalGateSpeaking,
  setVoiceStatus,
  setLocalCamera,
  setLocalScreenshare,
  setPttGated as setPttGatedState,
} from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { Disposable } from "@lib/disposable";
import { AudioPipeline } from "@lib/voice/audioPipeline";
import { AudioElements } from "@lib/voice/audioElements";
import { E2EEManager } from "@lib/voice/livekitE2EE";
import { DeviceManager } from "@lib/voice/deviceManager";
import {
  type CameraTrackState,
  type ScreenTrackState,
  bumpGeneration,
  stopManualCameraTrack,
  stopManualScreenTracks,
  type StreamQuality,
} from "@lib/voice/screenShare";
import { buildSessionDebugInfo } from "@lib/voice/livekitDiagnostics";
import { type RoomEventHandlers, createRoomEventHandlers } from "@lib/voice/roomEventHandlers";
import { VoiceTokenManager } from "@lib/voice/voiceTokenManager";
import { LiveKitUrlResolver } from "@lib/voice/livekitUrlResolver";
import { attemptAutoReconnect } from "@lib/voice/livekitReconnect";
import type { SessionState, RemoteVideoCallback, RemoteVideoRemovedCallback } from "./sessionState";
import { JoinOrchestration } from "./joinOrchestration";
import { isDmKeptForCall } from "../direct-messages/keptCallDms";
import { noteJoinSent } from "./joinRequest";
import { RoomLifecycle } from "./roomLifecycle";
import { MediaControl } from "./mediaControl";
import { RemoteTracks } from "./remoteTracks";
import { restoreLocalVoiceState, restoreMediaAfterReconnect } from "./localVoiceRestore";
import { noteWatchSent } from "@lib/voice/watchRequest";
import { type LostMedia, dismissMediaLostNotice } from "./mediaLostNotice";
import { isLinuxDesktop } from "./native/platform";
import { nativeCounters } from "./native/counters";
import { desktop } from "../../platform/desktop";
import { voiceText } from "../../i18n/voice";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { authStore } from "@stores/auth.store";

const log = createLogger("livekitSession");

/** Most ids one voice_watch carries (the server's cap). */
const MAX_WATCH_IDS = 16;

/** How long to wait before re-sending a rate-limited voice_watch. */
const WATCH_RETRY_MS = 1000;

/** P2-T5: how long a reconnect attempt waits for its voice_token_refresh
 *  reply before trying with the token it has. */
const RECONNECT_TOKEN_WAIT_MS = 10_000;

// --- LiveKitSession class ---

export class LiveKitSession {
  /** Single source of truth for all connection-lifecycle state. */
  private _state: SessionState = { type: "idle" };

  /** The ONLY source of join generations. Must never be
   *  re-derived from `_state` — a transition through "idle" (e.g. leaveVoice()
   *  during an in-flight connect) would reset a derived counter back to the
   *  same value a still-running stale attempt is holding, letting the two
   *  attempts collide on one generation and defeating every supersession
   *  checkpoint. Monotonic increments here guarantee every connectAndSetup()
   *  call gets a value no other attempt has ever held, regardless of how
   *  many times the session has bounced through "idle" in between. */
  private _joinGenerationCounter = 0;

  /** P2-T5: the latest token and when it arrived, so a long reconnect knows
   *  when it needs a fresh one (server TTL 5 minutes). */
  private _stampedToken: string | null = null;
  private _tokenReceivedAt = 0;
  /** The reconnect attempt waiting for a voice_token_refresh reply. */
  private _tokenWaiter: (() => void) | null = null;
  /** P2-T5: the reconnect loop sent voice_join and awaits the server's answer. */
  private _rejoinPending = false;

  // --- Non-connection fields (configuration / callbacks / infrastructure) ---
  private ws: WsClient | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private serverHost: string | null = null;
  /** Remote-video callbacks and the video stream lookups. */
  private _remoteTracks = this.createRemoteTracks();
  /** True while leaveVoice clears the watch set: the server clears on leave,
   *  so the clear must not send a voice_watch of its own. */
  private _leavingVoice = false;
  /** The pending retry after a rate-limited voice_watch. */
  private _watchRetry: ReturnType<typeof setTimeout> | null = null;
  /** Your screen share's last sender sample, for the support bundle. */
  private _shareSender: ShareSenderSample | null = null;
  /** The screen-share timeline of the current (or last) room session, and
   *  the owner whose signal stops its polling when the session ends. */
  private _shareDiag: ShareDiagnosticsRecorder | null = null;
  private _shareDiagOwner: Disposable | null = null;
  // Test-visibility proxies: the callbacks live on RemoteTracks.
  private get onRemoteVideoCallback(): RemoteVideoCallback | null {
    return this._remoteTracks.onRemoteVideoCallback;
  }
  private get onRemoteVideoRemovedCallback(): RemoteVideoRemovedCallback | null {
    return this._remoteTracks.onRemoteVideoRemovedCallback;
  }
  /** An explicit unmute waiting for this room's SFU publishing grant. */
  private pendingMicrophoneRoom: Room | null = null;

  // ── Client-side E2EE (ECDH key exchange) — extracted to E2EEManager ──────
  /** Owns all E2EE state and the key-exchange protocol: ECDH keypair, room-key
   *  generation/rotation, identity signing / TOFU verification (F3), and the
   *  announce/offer handlers. See livekitE2EE.ts. */
  private _e2ee = new E2EEManager({
    getWs: () => this.ws,
    getServerHost: () => this.serverHost,
    getCurrentChannelId: () => this._currentChannelId,
    onRoomKeyInstalled: () => this._eventHandlers.noteRoomKeyInstalled(),
  });

  // --- Test-visibility proxies (E2EE state lives in E2EEManager; unit tests
  //     reach these via `(session as any)` — keep the field names stable) ---
  private get _peerPublicKeys(): Map<number, CryptoKey> {
    return this._e2ee.peerPublicKeys;
  }
  private get _e2eeEpoch(): number {
    return this._e2ee.epoch;
  }
  private get _rotatingKey(): boolean {
    return this._e2ee.rotatingKey;
  }
  private set _rotatingKey(value: boolean) {
    this._e2ee.rotatingKey = value;
  }
  private get _rotationPending(): boolean {
    return this._e2ee.rotationPending;
  }
  private set _rotationPending(value: boolean) {
    this._e2ee.rotationPending = value;
  }
  private get _pendingAnnounces(): Array<{
    userId: number;
    publicKeyBase64: string;
    signatureBase64?: string;
    identityKeyBase64?: string;
  }> {
    return this._e2ee.pendingAnnounces;
  }
  /** Test-visibility delegate: periodic rotation lives on the E2EEManager. */
  private rotateKeyPeriodically(): Promise<void> {
    return this._e2ee.rotateKeyPeriodically();
  }

  // --- Extracted modules ---

  private _tokenManager = new VoiceTokenManager({
    getWs: () => this.ws,
    // P2-T5: a long auto-reconnect refreshes its token too.
    hasVoiceSession: () => this._room !== null || this._state.type === "reconnecting",
    // Retry at the rate-limit cadence, not the full periodic one —
    // see VoiceTokenManager.startRetryTimer.
    onRefreshTimeout: () => this._tokenManager.startRetryTimer(),
  });

  private _urlResolver = new LiveKitUrlResolver();

  // --- State transition (single writer) ---

  private setState(next: SessionState): void {
    const prev = this._state.type;
    this._state = next;
    if (
      (next.type === "connected" || next.type === "reconnecting") &&
      next.latestToken !== this._stampedToken
    ) {
      this._stampedToken = next.latestToken;
      this._tokenReceivedAt = Date.now();
    }
    log.debug("Session state transition", { from: prev, to: next.type });
  }

  // --- Typed state accessors (replace scattered field reads) ---

  /** Room from state, or null when idle/connecting/reconnecting. */
  private get _room(): Room | null {
    return this._state.type === "connected" ? this._state.room : null;
  }

  /** Channel ID from state, or null when idle/connecting. */
  private get _currentChannelId(): number | null {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.channelId
      : null;
  }

  /** The channel's configured audio encoding, or undefined when no
   *  voice_config has arrived for it yet (LiveKit's own audio default then
   *  applies, because the caller omits audioPreset entirely).
   *
   *  The server computes an audio bitrate from the channel's voice
   *  quality and delivers it via voice_config (setVoiceConfig ->
   *  voiceStore.voiceConfigs).
   *
   *  createRoom folds this into publishDefaults, but it runs
   *  synchronously from the voice_token handler and the server sends
   *  voice_config only afterwards — an ordering frozen by the epoch-1 golden
   *  transcripts, so it cannot be swapped on the wire. On a channel's first
   *  join the Room is therefore built before any config arrived. Every
   *  microphone publish happens later, past the LiveKit connect round-trip, so
   *  re-reading here picks up the bitrate the Room missed; publishDefaults
   *  stays the fallback for every other track. */
  private configuredAudioOptions(
    channelId: number | null,
  ): { audioPreset: { maxBitrate: number } } | undefined {
    if (channelId === null) return undefined;
    const bitrate = voiceStore.getState().voiceConfigs.get(channelId)?.bitrate;
    return bitrate === undefined ? undefined : { audioPreset: { maxBitrate: bitrate } };
  }

  /** Latest token from state, or null when idle/connecting. */
  private get _latestToken(): string | null {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.latestToken
      : null;
  }

  /** Last URL from state, or null when idle/connecting. */
  private get _lastUrl(): string | null {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.lastUrl
      : null;
  }

  /** Last direct URL from state. */
  private get _lastDirectUrl(): string | undefined {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.lastDirectUrl
      : undefined;
  }

  /** True while a connect attempt is running. */
  private get _connecting(): boolean {
    return this._state.type === "connecting";
  }

  /** The abort controller for an in-flight reconnect, or null. */
  private get _reconnectAc(): AbortController | null {
    return this._state.type === "reconnecting" ? this._state.ac : null;
  }

  // --- Extracted modules (facade pattern) ---
  /** Session-attempt ownership: connect, supersession checkpoints, join drain. */
  private _join = new JoinOrchestration({
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
  private _lifecycle = new RoomLifecycle({
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
  private _media = new MediaControl({
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
  private _audioPipeline = new AudioPipeline(isPttPollingLive);
  private _audioElements = new AudioElements();
  private _deviceManager = new DeviceManager();
  private _eventHandlers: RoomEventHandlers;

  /** Manually published local tracks (camera/screenshare) for explicit cleanup. */
  private _cameraState: CameraTrackState = { manualCameraTrack: null };
  private _screenState: ScreenTrackState = { manualScreenTracks: [] };

  constructor() {
    this._audioPipeline.onGateSpeaking = setLocalGateSpeaking;
    this._eventHandlers = createRoomEventHandlers({
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

  /** What teardownForReconnect stopped, restored once the reconnect (or its
   *  rejoin) lands. Cleared by leaveVoice, so a give-up restores nothing. */
  private _lostOnReconnect: LostMedia | null = null;

  /** Temporary holding field: populated by setRoom(null) in handleDisconnected's
   *  callback sequence so setReconnectAc can form the "reconnecting" state atomically. */
  private _pendingReconnectFields: {
    channelId: number;
    latestToken: string;
    lastUrl: string;
    lastDirectUrl: string | undefined;
  } | null = null;

  // --- Room lifecycle (delegated to RoomLifecycle) ---

  private async createRoom(channelId?: number): Promise<Room> {
    this.startShareDiagnostics();
    return this._lifecycle.createRoom(channelId);
  }

  /** One recorder per room session: a reconnect keeps it, leaveVoice stops
   *  it, and the next join starts a fresh one. */
  private startShareDiagnostics(): void {
    if (this._shareDiagOwner !== null) return;
    const recorder = new ShareDiagnosticsRecorder({
      enabled: () => getShareDiagnosticsEnabled(),
      // The Linux native capture never applies the test switch.
      policy: () => (isLinuxDesktop() ? "legacy" : getShareMotionPolicy()),
      shareEpoch: () => this.localScreenshareTrack(),
      readSender: () => this._remoteTracks.getLocalScreenshareStats(),
      watchedShares: () => this._remoteTracks.watchedScreenshares(),
      readViewer: (id) => this._remoteTracks.getRemoteVideoStats(id, "screenshare"),
      now: () => performance.now(),
    });
    const owner = new Disposable();
    this._shareDiag = recorder;
    this._shareDiagOwner = owner;
    recorder.start(owner.signal);
  }

  /** Stops polling but keeps the timeline: a test usually ends by leaving
   *  the call and then saving the support bundle. */
  private stopShareDiagnostics(): void {
    this._shareDiagOwner?.destroy();
    this._shareDiagOwner = null;
  }

  /** The recorded screen-share timeline, or null when nothing was recorded. */
  getShareDiagnostics(): ShareDiagnosticsSnapshot | null {
    const snapshot = this._shareDiag?.snapshot();
    return snapshot === undefined || snapshot.samples.length === 0 ? null : snapshot;
  }

  /** Update all extracted modules with a room reference. See RoomLifecycle. */
  private syncModuleRooms(room: Room | null = this._room): void {
    this._lifecycle.syncModuleRooms(room);
  }

  /** Attempt to auto-reconnect after unexpected disconnect using stored token.
   *  The signal is aborted by leaveVoice() to cancel the loop when the user
   *  voluntarily leaves voice during the reconnect delay. */
  private async attemptAutoReconnect(
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

  private createRemoteTracks(): RemoteTracks {
    const tracks = new RemoteTracks(() => this._room);
    tracks.onWatchingChange = (ids) => {
      if (!this._leavingVoice) this.sendWatching(ids);
    };
    return tracks;
  }

  /** Tell the server whose screen shares we watch (voice_watch), while we are
   *  in a voice channel with the socket up. A re-send (no `ids`) always sends
   *  the current set, empty included, because the server keeps the old set
   *  across a resume; `skipEmpty` is for a fresh join, where the server just
   *  cleared it. A refusal (a server from before 6.6) is ignored by the
   *  dispatcher via watchRequest. */
  private sendWatching(ids?: readonly number[], skipEmpty = false): void {
    // Deduped, sorted and within the server's cap of 16 (it counts the raw list).
    const current = [...new Set(ids ?? this._remoteTracks.watchedScreenshares())]
      .toSorted((a, b) => a - b)
      .slice(0, MAX_WATCH_IDS);
    if (skipEmpty && current.length === 0) return;
    if (this.ws === null || this.ws.getState() !== "connected") return;
    if (voiceStore.getState().currentChannelId === null) return;
    noteWatchSent(this.ws.send({ type: "voice_watch", payload: { user_ids: [...current] } }));
  }

  /** The socket resumed while in voice: re-send our own set (the server keeps
   *  it across a resume, but a change made while the socket was down was
   *  never sent). */
  resendWatching(): void {
    this.sendWatching();
  }

  /** The server rate-limited a voice_watch: send the current set once more
   *  after a second. leaveVoice clears the timer. */
  retryWatching(): void {
    if (this._watchRetry !== null) return;
    this._watchRetry = setTimeout(() => {
      this._watchRetry = null;
      this.sendWatching();
    }, WATCH_RETRY_MS);
  }

  /** Once a reconnect (or its rejoin) lands: bring back what the drop stopped. */
  private restoreLostMedia(): void {
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

  // --- URL resolution (delegated to LiveKitUrlResolver) ---

  private async resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string> {
    return this._urlResolver.resolve(proxyPath, directUrl);
  }

  // --- Token refresh (delegated to VoiceTokenManager) ---

  private startTokenRefreshTimer(): void {
    this._tokenManager.startRefreshTimer();
  }

  private clearTokenRefreshTimer(): void {
    this._tokenManager.clearTimers();
  }

  private requestTokenRefresh(): void {
    this._tokenManager.requestRefresh();
  }

  /** Request a refresh and resolve once a token lands, or after
   *  RECONNECT_TOKEN_WAIT_MS (rate-limited or unanswered). */
  private refreshTokenAndWait(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, RECONNECT_TOKEN_WAIT_MS);
      this._tokenWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.requestTokenRefresh();
    });
  }

  handleVoiceTokenRefresh(token?: string): void {
    // KNOWN LIMITATION: The livekit-client SDK does not expose a method to
    // rotate the token on an active connection. We store the fresh token so
    // that reconnection (auto-reconnect or manual rejoin) uses it, but the
    // live session continues with the original token. This means:
    //   - Sessions longer than the server's 5-minute TTL remain connected
    //     (LiveKit keeps active connections alive) but lose the ability to
    //     reconnect after a network blip once the original token expires.
    //   - The 4-minute refresh timer ensures a fresh token is always ready
    //     *before* the original expires, so reconnects within the window work.
    // See also: Server/ws/livekit.go tokenTTL constant (5 * time.Minute).
    if (token && this._state.type === "connected") {
      this.setState({ ...this._state, latestToken: token });
    } else if (token && this._state.type === "reconnecting") {
      this.setState({ ...this._state, latestToken: token });
    }
    this._tokenWaiter?.();
    this._tokenWaiter = null;
    this._tokenManager.handleRefreshResponse();
  }

  // --- Volume helpers ---

  private restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void> {
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
  setOnRemoteVideo(cb: RemoteVideoCallback): void {
    this._remoteTracks.setOnRemoteVideo(cb);
  }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
    this._remoteTracks.setOnRemoteVideoRemoved(cb);
  }

  clearOnRemoteVideo(): void {
    this._remoteTracks.clearOnRemoteVideo();
  }

  /** Shared connect-with-retry + post-connect setup used by both the primary
   *  handleVoiceToken path and the pending-join drain loop. See JoinOrchestration. */
  private async connectAndSetup(
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

  /** A refused voice_join ends a reconnect's rejoin for good: tell the user
   *  the call was lost, as the loop's own give-up does. */
  failPendingRejoin(): void {
    if (!this._rejoinPending) return;
    this._rejoinPending = false;
    this._lostOnReconnect = null;
    this.onErrorCallback?.(voiceText("reconnect.voiceLost"));
  }

  /** True while the auto-reconnect loop owns the session. */
  isAutoReconnecting(): boolean {
    return this._state.type === "reconnecting";
  }

  // ── Client-side E2EE delegates (state + protocol live in E2EEManager) ───

  /**
   * F3 TOFU re-pin recovery: pin the exact identity key the user verified
   * out-of-band, clearing a mismatch block. See E2EEManager.rePinPeerIdentity.
   */
  async rePinPeerIdentity(userId: number, verifiedKey: string): Promise<boolean> {
    return this._e2ee.rePinPeerIdentity(userId, verifiedKey);
  }

  /**
   * Handle a voice_e2ee_announce from the server — another participant has
   * announced their ECDH public key. See E2EEManager.handleAnnounce.
   */
  async handleE2EEAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
    identityKeyBase64?: string,
  ): Promise<void> {
    return this._e2ee.handleAnnounce(userId, publicKeyBase64, signatureBase64, identityKeyBase64);
  }

  /** The identity key from the peer's current announce, or null when they have
   *  announced none this call (the verify panel then falls back to the
   *  published key). See E2EEPeerState.announcedIdentityKey. */
  peerAnnouncedIdentityKey(userId: number): string | null {
    return this._e2ee.peerAnnouncedIdentityKey(userId);
  }

  /**
   * Handle a voice_e2ee_offer from the server — the key holder has sent us
   * the encrypted room key. See E2EEManager.handleOffer.
   */
  async handleE2EEOffer(
    fromUserId: number,
    encryptedKeyBase64: string,
    ivBase64: string,
  ): Promise<void> {
    return this._e2ee.handleOffer(fromUserId, encryptedKeyBase64, ivBase64);
  }

  /**
   * Handle a participant leaving the voice channel (key-holder election and
   * membership-forward-secrecy rekey). See E2EEManager.handleParticipantLeft.
   */
  async handleParticipantLeft(userId: number): Promise<void> {
    return this._e2ee.handleParticipantLeft(userId);
  }

  /** Retry microphone permission after being in listen-only mode. */
  async retryMicPermission(): Promise<void> {
    return this._media.retryMicPermission();
  }

  private sweepPublications(room: Room): void {
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

  // --- Media and device control (delegated to MediaControl) ---

  setMuted(muted: boolean): void {
    this._media.setMuted(muted);
  }

  setDeafened(deafened: boolean): void {
    this._media.setDeafened(deafened);
  }

  private async applyMicMuteState(muted: boolean): Promise<void> {
    return this._media.applyMicMuteState(muted);
  }

  async enableCamera(): Promise<void> {
    return this._media.enableCamera();
  }

  async disableCamera(): Promise<void> {
    return this._media.disableCamera();
  }

  async enableScreenshare(): Promise<void> {
    return this._media.enableScreenshare();
  }

  async disableScreenshare(): Promise<void> {
    return this._media.disableScreenshare();
  }

  /** `ready`'s camera/share flags for this user, checked against what we send. */
  reconcileVideoFlags(camera: boolean, screenshare: boolean): void {
    this._media.reconcileVideoFlags(camera, screenshare);
  }

  changeScreenshareSource(): Promise<void> {
    return this._media.changeScreenshareSource();
  }

  setScreenshareQuality(quality: StreamQuality): Promise<void> {
    return this._media.setScreenshareQuality(quality);
  }

  getScreenshareQuality(): StreamQuality | null {
    return this._media.getScreenshareQuality();
  }

  canChangeScreenshareSource(): boolean {
    return this._media.canChangeScreenshareSource();
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    return this._media.switchInputDevice(deviceId);
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    return this._media.switchOutputDevice(deviceId);
  }

  async switchVideoDevice(deviceId: string): Promise<void> {
    return this._media.switchVideoDevice(deviceId);
  }

  setUserVolume(userId: number, volume: number): void {
    this._media.setUserVolume(userId, volume);
  }

  getUserVolume(userId: number): number {
    return this._media.getUserVolume(userId);
  }

  setUserLocalMute(userId: number, muted: boolean): void {
    this._media.setUserLocalMute(userId, muted);
  }

  getUserLocalMute(userId: number): boolean {
    return this._media.getUserLocalMute(userId);
  }

  setScreenshareAudioVolume(userId: number, volume: number): void {
    this._media.setScreenshareAudioVolume(userId, volume);
  }

  getScreenshareAudioVolume(userId: number): number {
    return this._media.getScreenshareAudioVolume(userId);
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this._media.muteScreenshareAudio(userId, muted);
  }

  getScreenshareAudioMuted(userId: number): boolean {
    return this._media.getScreenshareAudioMuted(userId);
  }

  private reapplyMuteGain(): void {
    this._media.reapplyMuteGain();
  }

  setInputVolume(volume: number): void {
    this._media.setInputVolume(volume);
  }

  /** Hear the call capture's level reports where the room captures on its
   *  own (Linux native engine). Returns the unsubscribe. */
  onNativeInputLevel(listener: (rms: number | null, open: boolean) => void): () => void {
    return this._audioPipeline.onRoomInputLevel(listener);
  }

  setOutputVolume(volume: number): void {
    this._media.setOutputVolume(volume);
  }

  setVoiceSensitivity(sensitivity: number): void {
    this._media.setVoiceSensitivity(sensitivity);
  }

  /** Re-run the sensitivity gate for the saved input mode (Voice Activity
   *  gates on sensitivity, Push to Talk does not). */
  applyInputMode(): void {
    this._media.applyInputMode();
  }

  /** Push-to-talk: close (key up) or open (key down) the gate — the mic
   *  processor's, or the native room's own (AudioPipeline.setPttGated).
   *  Recorded in the store for the widget, applied to the live processor and
   *  to every one attached later. */
  setPttGated(gated: boolean): void {
    setPttGatedState(gated);
    this._media.setPttGated(gated);
  }

  async reapplyAudioProcessing(): Promise<void> {
    return this._media.reapplyAudioProcessing();
  }

  /** Route the live mic processor through or around RNNoise for the saved
   *  preference, without restarting the capture. */
  async reapplyEnhancedNoiseSuppression(): Promise<void> {
    return this._media.reapplyEnhancedNoiseSuppression();
  }

  getLocalCameraStream(): MediaStream | null {
    return this._remoteTracks.getLocalCameraStream();
  }

  getLocalScreenshareStream(): MediaStream | null {
    return this._remoteTracks.getLocalScreenshareStream();
  }

  /** What your screen share is sending; the last sample also goes into the
   *  support bundle's voice diagnostics. */
  async getLocalScreenshareStats(): Promise<ShareSenderSample | null> {
    const shared = this.localScreenshareTrack();
    const sample = await this._remoteTracks.getLocalScreenshareStats();
    // A read that outlived its share says nothing about the one now live.
    if (this.localScreenshareTrack() !== shared) return null;
    this._shareSender = sample;
    return sample;
  }

  private localScreenshareTrack(): object | undefined {
    return this._room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
  }

  /** Your screen share is publishing its audio too. */
  hasLocalScreenshareAudio(): boolean {
    return (
      this._room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined
    );
  }

  /** One receiver sample of a remote camera or screen share (video tile chip). */
  getRemoteVideoStats(
    userId: number,
    type: "camera" | "screenshare",
  ): Promise<StreamSample | null> {
    return this._remoteTracks.getRemoteVideoStats(userId, type);
  }

  /** Ask for only what a remote video tile shows. */
  setRemoteVideoView(userId: number, type: "camera" | "screenshare", view: VideoView): void {
    this._remoteTracks.setRemoteVideoView(userId, type, view);
  }

  /** Watch a remote camera or screen share, or stop: opt-in watching. */
  setRemoteVideoWatched(userId: number, type: "camera" | "screenshare", on: boolean): void {
    this._remoteTracks.watch(userId, type, on);
  }

  /** A remote stream ended: drop its watch without counting as Stop watching. */
  forgetRemoteVideoWatch(userId: number, type: "camera" | "screenshare"): void {
    this._remoteTracks.forgetWatch(userId, type);
  }

  getRoom(): Room | null {
    return this._room;
  }

  /** True while a join/connect attempt is in flight OR a room is live —
   *  i.e. `_state.type !== "idle"`. Unlike `getRoom() !== null`, this also
   *  covers "connecting" (no Room object exists yet) and "reconnecting" (the
   *  `_room` getter reads null there too): a caller that only
   *  wants to know "should we tear anything down" must not miss those. */
  hasActiveSession(): boolean {
    return this._state.type !== "idle";
  }

  /** The live microphone capture's settings, for Settings to name it. */
  getLocalMicSettings(): MediaTrackSettings | null {
    return this._audioPipeline.micSettings;
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
