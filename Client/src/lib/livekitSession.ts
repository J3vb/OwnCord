// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import { Room, Track } from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
  setPttGated,
  isPttPollingLive,
  setListenOnly,
  setVoiceStatus,
} from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { AudioPipeline } from "@lib/audioPipeline";
import { AudioElements } from "@lib/audioElements";
import { E2EEManager } from "@lib/livekitE2EE";
import { DeviceManager, isMicPolicyGated } from "@lib/deviceManager";
import {
  type VideoTrackDeps,
  type CameraTrackState,
  type ScreenTrackState,
  enableCamera as doEnableCamera,
  disableCamera as doDisableCamera,
  stopManualCameraTrack,
  enableScreenshare as doEnableScreenshare,
  disableScreenshare as doDisableScreenshare,
  stopManualScreenTracks,
  bumpGeneration,
  getLocalCameraStream as doGetLocalCameraStream,
  getLocalScreenshareStream as doGetLocalScreenshareStream,
  getRemoteVideoStream as doGetRemoteVideoStream,
} from "@lib/screenShare";
import { buildSessionDebugInfo } from "@lib/livekitDiagnostics";
import { createRoomEventHandlers, type RoomEventHandlers } from "@lib/roomEventHandlers";
import { VoiceTokenManager } from "@lib/voiceTokenManager";
import { LiveKitUrlResolver } from "@lib/livekitUrlResolver";
import { attemptAutoReconnect } from "@lib/livekitReconnect";
import type {
  RemoteVideoCallback,
  RemoteVideoRemovedCallback,
  SessionState,
} from "../features/voice/sessionState";
import { JoinOrchestration } from "../features/voice/joinOrchestration";
import { RoomLifecycle } from "../features/voice/roomLifecycle";

// Re-export StreamQuality so existing consumers don't break
export type { StreamQuality } from "@lib/screenShare";

const log = createLogger("livekitSession");

// --- Push-to-talk liveness (cross-module signal, no instance state) ---

/** Re-exported from the voice store, which owns the flag so `ptt.ts` can write
 *  it at startup without importing this module (and the ~1.3 MB livekit-client
 *  SDK behind it). See `voice.store.ts` for the platform-capability contract. */
export { setPttPollingLive } from "@stores/voice.store";

// --- Session state types + pure helpers (leaf module) ---

export { parseUserId } from "../features/voice/sessionState";
export type {
  RemoteVideoCallback,
  RemoteVideoRemovedCallback,
} from "../features/voice/sessionState";

// --- LiveKitSession class ---

export class LiveKitSession {
  /** Single source of truth for all connection-lifecycle state. */
  private _state: SessionState = { type: "idle" };

  /** BUG-142 fix: the ONLY source of join generations. Must never be
   *  re-derived from `_state` — a transition through "idle" (e.g. leaveVoice()
   *  during an in-flight connect) would reset a derived counter back to the
   *  same value a still-running stale attempt is holding, letting the two
   *  attempts collide on one generation and defeating every supersession
   *  checkpoint. Monotonic increments here guarantee every connectAndSetup()
   *  call gets a value no other attempt has ever held, regardless of how
   *  many times the session has bounced through "idle" in between. */
  private _joinGenerationCounter = 0;

  // --- Non-connection fields (configuration / callbacks / infrastructure) ---
  private ws: WsClient | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private serverHost: string | null = null;
  private onRemoteVideoCallback: RemoteVideoCallback | null = null;
  private onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
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
    isRoomConnected: () => this._room !== null,
    // OC-0429: retry at the rate-limit cadence, not the full periodic one —
    // see VoiceTokenManager.startRetryTimer.
    onRefreshTimeout: () => this._tokenManager.startRetryTimer(),
  });

  private _urlResolver = new LiveKitUrlResolver();

  // --- State transition (single writer) ---

  private setState(next: SessionState): void {
    const prev = this._state.type;
    this._state = next;
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
   *  OC-0438: the server computes an audio bitrate from the channel's voice
   *  quality and delivers it via voice_config (setVoiceConfig ->
   *  voiceStore.voiceConfigs).
   *
   *  OC-0441: createRoom folds this into publishDefaults, but it runs
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
    startTokenRefreshTimer: () => this.startTokenRefreshTimer(),
    syncModuleRooms: () => this.syncModuleRooms(),
    leaveVoice: (sendWs) => this.leaveVoice(sendWs),
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
    microphonePublishingAllowed: (room) => this.microphonePublishingAllowed(room),
    applyMicMuteState: (muted) => this.applyMicMuteState(muted),
  });
  private _audioPipeline = new AudioPipeline();
  private _audioElements = new AudioElements();
  private _deviceManager = new DeviceManager();
  private _eventHandlers: RoomEventHandlers;

  /** Manually published local tracks (camera/screenshare) for explicit cleanup. */
  private _cameraState: CameraTrackState = { manualCameraTrack: null };
  private _screenState: ScreenTrackState = { manualScreenTracks: [] };

  /** Lazily built deps for the extracted video track functions. */
  private get _videoTrackDeps(): VideoTrackDeps {
    return {
      getRoom: () => this._room,
      getWs: () => this.ws,
      onError: (msg) => {
        this.onErrorCallback?.(msg);
      },
      reapplyAudioPipeline: () => {
        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
      },
    };
  }

  constructor() {
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
      getOnErrorCallback: () => this.onErrorCallback,
      isConnecting: () => this._connecting,
      isReconnecting: () => this._state.type === "reconnecting",
      getLatestToken: () => this._latestToken,
      getLastUrl: () => this._lastUrl,
      getLastDirectUrl: () => this._lastDirectUrl,
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
        if (this.ws !== null) {
          if (localCamera) {
            this.ws.send({ type: "voice_camera", payload: { enabled: false } });
          }
          if (localScreenshare) {
            this.ws.send({ type: "voice_screenshare", payload: { enabled: false } });
          }
        }
        // OC-0080: bump first, mirroring doDisableCamera/doDisableScreenshare
        // — a concurrent enableCamera()/enableScreenshare() still awaiting
        // device acquisition (getUserMedia/getDisplayMedia/publishTrack) when
        // an unexpected disconnect fires must detect it was superseded and
        // discard its track instead of publishing onto the room about to be
        // torn down for auto-reconnect.
        bumpGeneration(this._cameraState);
        bumpGeneration(this._screenState);
        // BUG-098: Stop leaked camera/screen tracks before room is nulled.
        stopManualCameraTrack(this._cameraState, this._room);
        stopManualScreenTracks(this._screenState, this._room);
        setLocalCamera(false);
        setLocalScreenshare(false);
      },
      leaveVoice: (sendWs) => this.leaveVoice(sendWs),
      applyMicMuteState: (muted) => this.applyMicMuteState(muted),
      attemptAutoReconnect: (token, url, channelId, directUrl, signal) =>
        this.attemptAutoReconnect(token, url, channelId, directUrl, signal),
    });
  }

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
    return this._lifecycle.createRoom(channelId);
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
      leaveVoice: () => this.leaveVoice(true),
      onError: (msg) => this.onErrorCallback?.(msg),
      isStateConnected: (id, room) => this._join.isStateConnected(id, room),
      disconnectSupersededLocalRoom: (room) => this._join.disconnectSupersededLocalRoom(room),
      setupAudioPipeline: () => this._audioPipeline.setupAudioPipeline(),
      reapplyMuteGain: () => this.reapplyMuteGain(),
      clearPendingReconnectFields: () => {
        this._pendingReconnectFields = null;
      },
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
    this._tokenManager.handleRefreshResponse();
  }

  // --- Volume helpers ---

  private async restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void> {
    const room = this._room;
    if (room === null) return;

    const state = voiceStore.getState();
    // A bound PTT key means transmission is gated by press/release, but the
    // Rust poller only emits ptt-state on a state TRANSITION — an idle key
    // produces no event at all, so without this the freshly published mic
    // would stay hot and transmitting until the user's first press+release.
    // Only arm this when the poller is confirmed live (setPttPollingLive) —
    // gating on the stored key alone would close the mic permanently on
    // platforms where PTT can never actually report state (macOS's
    // is_key_down stub, pure-Wayland Linux with no XWayland).
    // Record the gate in pttGated, NEVER in localMuted: localMuted means "the
    // user muted themselves", and ptt.ts refuses to open the mic on a PTT
    // press while it is set — writing it here would close the mic for the
    // whole session instead of only until the first press.
    // On reconnect, don't recompute pttArmed from scratch — that always
    // yields false (mode !== "join") and ignores whatever pttGated the store
    // is still carrying from before the disconnect. If the user joined with
    // PTT armed and never pressed the key before the connection dropped, the
    // gate is still supposed to be closed; reading it back here (instead of
    // silently reopening the mic) is what keeps that promise across a
    // reconnect.
    const pttArmed =
      mode === "join"
        ? isPttPollingLive() && loadPref<number>("pttVk", 0) !== 0
        : state.pttGated === true;
    if (mode === "join") {
      setPttGated(pttArmed);
    }
    const muted = pttArmed || state.localMuted || state.localDeafened;
    const deafened = state.localDeafened;
    const shouldEnableMicrophone = !muted;

    try {
      await this.enableMicrophone(room, shouldEnableMicrophone);
      if (this._room !== room) return;
      if (shouldEnableMicrophone) {
        log.info(
          mode === "join"
            ? "Published mic via LiveKit native capture"
            : "Auto-reconnect restored live microphone",
        );
        if (loadPref<boolean>("enhancedNoiseSuppression", false)) {
          await this._audioPipeline.applyNoiseSuppressor();
        }
      }
      if (this._room !== room) return;
      setListenOnly(false); // Mic acquired successfully
    } catch (micErr) {
      if (this._room !== room) return;
      setListenOnly(true);
      if (mode === "reconnect") {
        log.warn("Auto-reconnect: mic unavailable — listen-only mode", micErr);
      } else if (micErr instanceof DOMException && micErr.name === "NotAllowedError") {
        log.warn("Microphone permission denied — joined in listen-only mode");
        this.onErrorCallback?.("Microphone permission denied — joined in listen-only mode");
      } else if (micErr instanceof DOMException && micErr.name === "NotFoundError") {
        log.warn("No microphone found — joined in listen-only mode");
        this.onErrorCallback?.("No microphone found — joined in listen-only mode");
      } else {
        log.warn("Microphone unavailable — joined in listen-only mode", micErr);
        this.onErrorCallback?.("Microphone unavailable — joined in listen-only mode");
      }
    }

    // OC-0008: setMicrophoneEnabled above can block for seconds on the
    // browser's mic-permission prompt. If a newer session claimed `_room`
    // while this call was suspended there (the user switched channels, or an
    // auto-reconnect installed a fresh room), the writes below re-read
    // `this._room` fresh (applyMicMuteState) instead of the `room` captured
    // at the top of this call — applying THIS call's stale muted/deafened
    // decision to that newer room would mute/unmute or resubscribe audio on
    // a session that never asked for it. Bail out once the captured room is
    // no longer the live one; the newer session owns its own state from here.
    if (this._room !== room) {
      log.info("restoreLocalVoiceState: superseded mid-call — discarding stale mute/deafen state");
      return;
    }

    // Always enforce mute at the track level even if no pipeline exists yet.
    // setMicrophoneEnabled(false) doesn't guarantee mediaStreamTrack.enabled=false,
    // and renegotiation when a new participant joins can bring a track back alive.
    if (muted) {
      this.applyMicMuteState(true).catch((e) =>
        log.warn("applyMicMuteState failed in restoreLocalVoiceState", e),
      );
    }

    this._audioElements.applyRemoteAudioSubscriptionState(deafened);
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
    this.onRemoteVideoCallback = cb;
  }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
    this.onRemoteVideoRemovedCallback = cb;
  }

  clearOnRemoteVideo(): void {
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
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
    return this._join.handleVoiceToken(token, url, channelId, directUrl, isKeyHolder);
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
  ): Promise<void> {
    return this._e2ee.handleAnnounce(userId, publicKeyBase64, signatureBase64);
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
    const room = this._room;
    if (room === null) return;
    try {
      await this.enableMicrophone(room, true);
      if (this._room !== room) return;
      setListenOnly(false);
      // BUG-103: Honor deafened state — keep mic muted if user is deafened.
      // Also honor a moderator's server-mute, a genuine self-mute, and an
      // unpressed push-to-talk key the same way: a listen-only join publishes
      // no audio track, so none of these have anything to act on and persist
      // silently — republishing here must not hand the whole channel a
      // fresh, unmuted track. Shares applyMicMuteState's own gate rather
      // than re-deriving a narrower one (the setMuted() guard does not cover
      // this direct setMicrophoneEnabled call).
      if (isMicPolicyGated()) {
        await this.applyMicMuteState(true);
        if (this._room !== room) return;
        log.info("Microphone acquired but muted (mute/deafen/server-mute/PTT gate active)");
      } else {
        setLocalMuted(false);
        log.info("Microphone permission granted — exited listen-only mode");
      }
      // Set up audio pipeline for the new mic track
      this._audioPipeline.setupAudioPipeline();
      if (loadPref<boolean>("enhancedNoiseSuppression", false)) {
        await this._audioPipeline.applyNoiseSuppressor();
      }
    } catch (err) {
      if (this._room !== room) return;
      log.warn("Microphone retry failed — still in listen-only mode", err);
      this.onErrorCallback?.("Microphone still unavailable — check your browser permissions");
    }
  }

  leaveVoice(sendWs = true): void {
    this._lifecycle.leaveVoice(sendWs);
  }

  /** Stays on the facade: past leaveVoice(false) it only clears the session's
   *  own configuration fields, which the room lifecycle does not own. */
  cleanupAll(): void {
    this.leaveVoice(false);
    // leaveVoice() already transitions state to "idle".
    // Clear non-connection fields (config / callbacks / infrastructure).
    this.onErrorCallback = null;
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
    this.ws = null;
    this.serverHost = null;
    this._urlResolver.setServerHost(null);
    this._e2ee.clearIdentityKeyPair();
    // Stop the Rust-side TLS proxy (fire-and-forget).
    this._urlResolver.stopProxy();
  }

  setMuted(muted: boolean): void {
    // Keep local state aligned with the moderator's SFU restriction. PTT
    // calls this method directly, so it shares the widget's unmute refusal.
    // Muting is always permitted.
    if (!muted && voiceStore.getState().localServerMuted === true) {
      log.debug("Ignoring unmute: server-muted by a moderator");
      return;
    }
    setLocalMuted(muted);
    this.applyMicMuteState(muted).catch((e) => log.warn("applyMicMuteState failed", e));
  }

  setDeafened(deafened: boolean): void {
    // Mirror setMuted's guard: a moderator-imposed deafen is not ours to
    // lift locally. Without this, undeafening while server-deafened
    // resubscribes remote audio and unmutes the mic client-side even though
    // the server still considers the user deafened — see setMuted() above
    // for why the refusal must live in this shared entry point.
    if (!deafened && voiceStore.getState().localServerDeafened === true) {
      log.debug("Ignoring undeafen: server-deafened by a moderator");
      return;
    }
    setLocalDeafened(deafened);
    this._audioElements.applyRemoteAudioSubscriptionState(deafened);
    const shouldMute = deafened || voiceStore.getState().localMuted;
    this.applyMicMuteState(shouldMute).catch((e) => log.warn("applyMicMuteState failed", e));
    log.debug("Deafen state changed", { deafened });
  }

  /** Enable or disable the microphone, carrying the channel's configured
   *  audio bitrate on any publish (OC-0441). Disabling publishes nothing, and
   *  a channel with no voice_config keeps LiveKit's own default, so both leave
   *  the call shaped exactly as it was before. */
  private async enableMicrophone(room: Room, enabled: boolean): Promise<void> {
    const publishOptions = enabled
      ? this.configuredAudioOptions(this._currentChannelId)
      : undefined;
    if (publishOptions === undefined) {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      return;
    }
    await room.localParticipant.setMicrophoneEnabled(enabled, undefined, publishOptions);
  }

  private microphonePublishingAllowed(room: Room): boolean {
    const permissions = room.localParticipant.permissions;
    return (
      permissions === undefined ||
      (permissions.canPublish &&
        (permissions.canPublishSources.length === 0 ||
          permissions.canPublishSources.includes(Track.sourceToProto(Track.Source.Microphone))))
    );
  }

  /** Mute the SDK microphone track and tear down processing; capture/publish
   *  again when unmuting if the SFU withdrew the previous publication. */
  private async applyMicMuteState(muted: boolean): Promise<void> {
    const room = this._room;
    if (room === null) return;
    if (muted) {
      this.pendingMicrophoneRoom = null;
      // Tear down pipeline first so it doesn't hold refs to the track
      this._audioPipeline.teardownAudioPipeline();
      // Disable the mic through the SDK. With stopMicTrackOnMute in the
      // Room's publishDefaults this stops the underlying capture track, so
      // the OS microphone in-use indicator goes out. The LiveKit publication
      // itself is NOT removed — it survives muted, and unmute re-acquires the
      // device (LocalAudioTrack.unmute -> restart). Only a screen-share track
      // actually unpublishes on end.
      await room.localParticipant.setMicrophoneEnabled(false);
      log.debug("Mic disabled (muted)");
    } else {
      // A push-to-talk gate (or, defensively, a moderator's server-mute) is
      // not this call's to lift — setMuted/setDeafened only guard their own
      // flag before calling here, so this is the one place every re-enable
      // path (present and future) shares the full policy check.
      if (isMicPolicyGated()) {
        this.pendingMicrophoneRoom = null;
        log.debug("Skipping mic re-publish — still gated (mute/deafen/server-mute/PTT)");
        return;
      }
      // Moderator unmute travels over OwnCord WS; the SFU grant arrives on
      // LiveKit's separate signal socket. Wait for that grant instead of
      // misreporting a publish refusal as a missing microphone. The intent
      // belongs only to this room and is cleared by mute/leave/reconnect.
      if (!this.microphonePublishingAllowed(room)) {
        this.pendingMicrophoneRoom = room;
        return;
      }
      this.pendingMicrophoneRoom = null;
      // Re-enable mic, publishing a new track if needed. Every caller
      // (setMuted/setDeafened's unmute branches, ptt.ts, roomEventHandlers)
      // fires this forgetfully with only a `.catch(e => log.warn(...))`, so a
      // rejection here (permission revoked, device unplugged) must not
      // propagate silently: without recovery, setLocalMuted(false) and the
      // outbound voice_mute{muted:false} frame have already gone out by the
      // time this runs, leaving the client reporting itself unmuted to the
      // server and every peer while publishing no audio at all (OC-0287).
      // Fall back into listen-only + muted so the state matches reality and
      // the existing "Grant Microphone" affordance (gated on listenOnly)
      // reappears as the recovery path.
      try {
        await this.enableMicrophone(room, true);
        if (this._room !== room) return;
        // Rebuild the audio pipeline on the fresh track
        this._audioPipeline.setupAudioPipeline();
        log.debug("Mic enabled (unmuted)");
      } catch (err) {
        if (this._room !== room) return;
        if (!this.microphonePublishingAllowed(room)) {
          this.pendingMicrophoneRoom = room;
          return;
        }
        setListenOnly(true);
        setLocalMuted(true);
        log.warn("Mic re-publish failed — falling back to listen-only/muted", err);
        this.onErrorCallback?.("Microphone unavailable — you are muted");
      }
    }
  }

  async enableCamera(): Promise<void> {
    return doEnableCamera(this._cameraState, this._videoTrackDeps);
  }

  async disableCamera(): Promise<void> {
    return doDisableCamera(this._cameraState, this._videoTrackDeps);
  }

  async enableScreenshare(): Promise<void> {
    return doEnableScreenshare(this._screenState, this._videoTrackDeps);
  }

  async disableScreenshare(): Promise<void> {
    return doDisableScreenshare(this._screenState, this._videoTrackDeps);
  }

  // --- Delegating methods to DeviceManager ---

  async switchInputDevice(deviceId: string): Promise<void> {
    return this._deviceManager.switchInputDevice(deviceId);
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    return this._deviceManager.switchOutputDevice(deviceId);
  }

  // --- Delegating methods to AudioElements ---

  setUserVolume(userId: number, volume: number): void {
    this._audioElements.setUserVolume(userId, volume);
  }

  getUserVolume(userId: number): number {
    return this._audioElements.getUserVolume(userId);
  }

  setScreenshareAudioVolume(userId: number, volume: number): void {
    this._audioElements.setScreenshareAudioVolume(userId, volume);
  }

  getScreenshareAudioVolume(userId: number): number {
    return this._audioElements.getScreenshareAudioVolume(userId);
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this._audioElements.muteScreenshareAudio(userId, muted);
  }

  getScreenshareAudioMuted(userId: number): boolean {
    return this._audioElements.getScreenshareAudioMuted(userId);
  }

  // --- Audio pipeline delegates (all state lives in AudioPipeline) ---

  /** Re-apply mute/deafen state after events that may reset the audio pipeline. */
  private reapplyMuteGain(): void {
    const { localMuted, localDeafened } = voiceStore.getState();
    if (localMuted || localDeafened) {
      this.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed", e));
    }
  }

  setInputVolume(volume: number): void {
    this._audioPipeline.setInputVolume(volume);
  }

  setOutputVolume(volume: number): void {
    this._audioElements.setOutputVolume(volume);
  }

  setVoiceSensitivity(sensitivity: number): void {
    this._audioPipeline.setVoiceSensitivity(sensitivity);
  }

  async reapplyAudioProcessing(): Promise<void> {
    return this._audioPipeline.reapplyAudioProcessing(this.onErrorCallback ?? undefined);
  }

  getLocalCameraStream(): MediaStream | null {
    return doGetLocalCameraStream(this._room);
  }

  getLocalScreenshareStream(): MediaStream | null {
    return doGetLocalScreenshareStream(this._room);
  }

  /** Get a remote participant's video MediaStream by userId and track type. Returns null if not available. */
  getRemoteVideoStream(userId: number, type: "camera" | "screenshare"): MediaStream | null {
    return doGetRemoteVideoStream(this._room, userId, type);
  }

  getRoom(): Room | null {
    return this._room;
  }

  /** True while a join/connect attempt is in flight OR a room is live —
   *  i.e. `_state.type !== "idle"`. Unlike `getRoom() !== null`, this also
   *  covers "connecting" (no Room object exists yet) and "reconnecting" (the
   *  `_room` getter reads null there too) — see OC-0249: a caller that only
   *  wants to know "should we tear anything down" must not miss those. */
  hasActiveSession(): boolean {
    return this._state.type !== "idle";
  }

  getSessionDebugInfo(): Record<string, unknown> {
    return buildSessionDebugInfo({
      room: this._room,
      currentChannelId: this._currentChannelId,
      outputVolumeMultiplier: this._audioElements.getOutputVolumeMultiplier(),
      audioPipeline: this._audioPipeline,
      audioElements: this._audioElements,
    });
  }
}

// --- Singleton instance + re-exported bound methods ---

const session = new LiveKitSession();

// Expose debug info on window under __owncord namespace for DevTools console access
// Usage: JSON.stringify(__owncord.lkDebug(), null, 2)
const owncordNs = ((window as unknown as Record<string, unknown>).__owncord ??= {}) as Record<
  string,
  unknown
>;
owncordNs.lkDebug = session.getSessionDebugInfo.bind(session);

export const setWsClient = session.setWsClient.bind(session);
export const setServerHost = session.setServerHost.bind(session);
export const setOnError = session.setOnError.bind(session);
export const setOnRemoteVideo = session.setOnRemoteVideo.bind(session);
export const setOnRemoteVideoRemoved = session.setOnRemoteVideoRemoved.bind(session);
export const clearOnRemoteVideo = session.clearOnRemoteVideo.bind(session);
export const handleVoiceToken = session.handleVoiceToken.bind(session);
export const handleE2EEAnnounce = session.handleE2EEAnnounce.bind(session);
export const handleE2EEOffer = session.handleE2EEOffer.bind(session);
export const rePinPeerIdentity = session.rePinPeerIdentity.bind(session);
export const handleParticipantLeft = session.handleParticipantLeft.bind(session);
export const leaveVoice = session.leaveVoice.bind(session);
export const retryMicPermission = session.retryMicPermission.bind(session);
export const cleanupAll = session.cleanupAll.bind(session);
export const setMuted = session.setMuted.bind(session);
export const setDeafened = session.setDeafened.bind(session);
export const enableCamera = session.enableCamera.bind(session);
export const disableCamera = session.disableCamera.bind(session);
export const enableScreenshare = session.enableScreenshare.bind(session);
export const disableScreenshare = session.disableScreenshare.bind(session);
export const switchInputDevice = session.switchInputDevice.bind(session);
export const switchOutputDevice = session.switchOutputDevice.bind(session);
export const setUserVolume = session.setUserVolume.bind(session);
export const getUserVolume = session.getUserVolume.bind(session);
export const setInputVolume = session.setInputVolume.bind(session);
export const setOutputVolume = session.setOutputVolume.bind(session);
export const setVoiceSensitivity = session.setVoiceSensitivity.bind(session);
export const reapplyAudioProcessing = session.reapplyAudioProcessing.bind(session);
export const getLocalCameraStream = session.getLocalCameraStream.bind(session);
export const getLocalScreenshareStream = session.getLocalScreenshareStream.bind(session);
export const getRemoteVideoStream = session.getRemoteVideoStream.bind(session);
export const getSessionDebugInfo = session.getSessionDebugInfo.bind(session);
export const setScreenshareAudioVolume = session.setScreenshareAudioVolume.bind(session);
export const getScreenshareAudioVolume = session.getScreenshareAudioVolume.bind(session);
export const muteScreenshareAudio = session.muteScreenshareAudio.bind(session);
export const getScreenshareAudioMuted = session.getScreenshareAudioMuted.bind(session);

/** True while a join is in flight ("connecting"/"reconnecting") OR a room is
 *  live ("connected") — i.e. there is something for leaveVoice() to tear
 *  down. OC-0249: a Room-existence check alone reads false for the entire
 *  "connecting" state (no Room object exists yet), so a caller deciding
 *  whether to abort an in-flight join must ask this instead. */
export function isVoiceSessionActive(): boolean {
  return session.hasActiveSession();
}

export function getRoomForStats(): Room | null {
  return session.getRoom();
}
