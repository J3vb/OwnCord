// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import { Room, RoomEvent } from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
  setPttGated,
  isPttPollingLive,
  leaveVoiceChannel,
  setListenOnly,
  setVoiceStatus,
} from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { invoke } from "@tauri-apps/api/core";
import { AudioPipeline } from "@lib/audioPipeline";
import { AudioElements } from "@lib/audioElements";
import { E2EEManager } from "@lib/livekitE2EE";
import { DeviceManager, isMicPolicyGated } from "@lib/deviceManager";
import {
  type VideoTrackDeps,
  type CameraTrackState,
  type ScreenTrackState,
  CAMERA_PRESETS,
  CAMERA_PUBLISH_BITRATES,
  getStreamQuality,
  getScreenShareFps,
  getEffectiveScreenShareFps,
  getScreenShareMaxBitrate,
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
import {
  logIceConnectionInfo,
  buildSessionDebugInfo,
  attachDiagnosticListeners,
} from "@lib/livekitDiagnostics";
import { createRoomEventHandlers, type RoomEventHandlers } from "@lib/roomEventHandlers";

// Re-export StreamQuality so existing consumers don't break
export type { StreamQuality } from "@lib/screenShare";

const log = createLogger("livekitSession");

// --- Push-to-talk liveness (cross-module signal, no instance state) ---

/** Re-exported from the voice store, which owns the flag so `ptt.ts` can write
 *  it at startup without importing this module (and the ~1.3 MB livekit-client
 *  SDK behind it). See `voice.store.ts` for the platform-capability contract. */
export { setPttPollingLive } from "@stores/voice.store";

// --- Pure helpers (no instance state) ---

/** Parse userId from LiveKit participant identity "user-{id}" or "user-{id}:{token}". Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)(?::|$)/);
  if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
  return 0;
}

// --- Types ---

export type RemoteVideoCallback = (
  userId: number,
  stream: MediaStream,
  isScreenshare: boolean,
) => void;
export type RemoteVideoRemovedCallback = (userId: number, isScreenshare: boolean) => void;
type PendingVoiceJoin = {
  readonly token: string;
  readonly url: string;
  readonly channelId: number;
  readonly directUrl?: string;
  readonly isKeyHolder?: boolean;
};

// --- State machine ---

/** Discriminated-union session state. All connection-lifecycle fields live here.
 *  The "connecting" variant also carries the BUG-142 monotonic generation counter
 *  (joinGeneration) so superseded-join detection is co-located with the state. */
type SessionState =
  | { readonly type: "idle" }
  | {
      readonly type: "connecting";
      readonly pendingJoin: PendingVoiceJoin | null;
      readonly joinGeneration: number;
    }
  | {
      readonly type: "connected";
      readonly room: Room;
      readonly channelId: number;
      readonly latestToken: string;
      readonly lastUrl: string;
      readonly lastDirectUrl: string | undefined;
    }
  | {
      readonly type: "reconnecting";
      readonly channelId: number;
      readonly latestToken: string;
      readonly lastUrl: string;
      readonly lastDirectUrl: string | undefined;
      readonly ac: AbortController;
    };

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
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** BUG-146: Guard timer — fires if the server never responds to voice_token_refresh. */
  private tokenRefreshTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** OC-0029: epoch ms of the last voice_token_refresh actually sent. The
   *  server budgets this request to 1 per 60s per user (Server/ws/voice_join.go);
   *  requestTokenRefresh() has multiple independent callers (the 4-minute
   *  timer AND attemptAutoReconnect's post-recovery refresh) that can land
   *  within seconds of each other, so this shared entry point — not each
   *  caller — is what enforces the budget. 0 (never sent) never blocks. */
  private _lastTokenRefreshSentAt = 0;
  /** Max auto-reconnect attempts before giving up and showing error. */
  private static readonly MAX_RECONNECT_ATTEMPTS = 2;
  private static readonly RECONNECT_DELAY_MS = 3000;
  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier = loadPref<number>("outputVolume", 100) / 100;
  /** Cached port for the local LiveKit TLS proxy (Rust-side, for self-signed cert support). */
  private liveKitProxyPort: number | null = null;

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

  /** Helper to check state is "connected" for a specific channelId, reading
   *  through a method call so TS control-flow narrowing cannot cache the result.
   *  Used in connectAndSetup() checkpoints after setState() transitions. */
  private isStateConnected(channelId: number): boolean {
    const s: SessionState = this._state;
    return s.type === "connected" && s.channelId === channelId;
  }

  // --- Extracted modules (facade pattern) ---
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

  // --- Room factory ---

  /** The current room's E2EE worker. livekit never terminates it, so the
   *  session must — a leaked worker keeps receiving every future room key
   *  through the process-lifetime key provider's setKey fan-out. */
  private _e2eeWorker: Worker | null = null;

  private async createRoom(): Promise<Room> {
    // livekit's per-room E2EEManager registers a SetKey listener on the
    // shared key provider and never removes it; only those managers
    // subscribe, so clear them all before the new Room re-registers.
    this._e2ee.keyProvider.removeAllListeners();
    this._e2eeWorker?.terminate();
    this._e2eeWorker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url));
    const quality = getStreamQuality();
    const isSource = quality === "source";
    const newRoom = new Room({
      // Adaptive features reduce quality based on subscriber viewport —
      // disable for "source" quality to maintain full resolution.
      adaptiveStream: !isSource,
      dynacast: !isSource,
      audioCaptureDefaults: {
        echoCancellation: loadPref("echoCancellation", true),
        noiseSuppression: loadPref("noiseSuppression", true),
        autoGainControl: loadPref("autoGainControl", true),
      },
      videoCaptureDefaults: CAMERA_PRESETS[quality],
      publishDefaults: {
        videoEncoding: {
          maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 15 : 30,
        },
        // Fallback for setScreenShareEnabled paths — the manual publish in
        // screenShare.ts passes explicit per-track encoding that overrides this.
        screenShareEncoding: {
          maxBitrate: getScreenShareMaxBitrate(quality, getScreenShareFps()),
          maxFramerate: getEffectiveScreenShareFps(quality, getScreenShareFps()),
        },
      },
      // End-to-end encryption: SFrame-based E2EE using a server-distributed
      // per-channel symmetric key. The SFU only sees encrypted frames.
      e2ee: {
        keyProvider: this._e2ee.keyProvider,
        worker: this._e2eeWorker,
      },
    });
    // OC-0095: the Room constructor only wires up the E2EEManager — it never
    // enables encryption. Without this, LocalParticipant.encryptionType stays
    // NONE, the worker's encode transform takes the disabled passthrough
    // branch, and every frame reaches the SFU in plaintext even though the
    // full ECDH/HKDF/AES-GCM key exchange above completed successfully.
    // Safe to call before connect(): the manager just records the enabled
    // flag and it's a no-op today for the "" pre-connect identity, then wires
    // up for real once the SignalConnected handler has the real identity.
    await newRoom.setE2EEEnabled(true);
    newRoom.on(RoomEvent.TrackSubscribed, this._eventHandlers.handleTrackSubscribed);
    newRoom.on(RoomEvent.TrackUnsubscribed, this._eventHandlers.handleTrackUnsubscribed);
    newRoom.on(RoomEvent.Disconnected, this._eventHandlers.handleDisconnected);
    newRoom.on(RoomEvent.ActiveSpeakersChanged, this._eventHandlers.handleActiveSpeakersChanged);
    newRoom.on(
      RoomEvent.AudioPlaybackStatusChanged,
      this._eventHandlers.handleAudioPlaybackChanged,
    );
    newRoom.on(RoomEvent.LocalTrackPublished, this._eventHandlers.handleLocalTrackPublished);
    // OC-0002: the only SDK-level signal that the E2EE worker died after the
    // key exchange already succeeded — see roomEventHandlers.ts for detail.
    newRoom.on(RoomEvent.EncryptionError, this._eventHandlers.handleEncryptionError);
    attachDiagnosticListeners(newRoom);

    return newRoom;
  }

  // --- Module wiring helper ---

  /** Update all extracted modules with the current room reference. */
  private syncModuleRooms(): void {
    const room = this._room;
    this._audioPipeline.setRoom(room);
    this._audioElements.setRoom(room);
    this._deviceManager.setRoom(room);
    this._deviceManager.setAudioPipeline(room !== null ? this._audioPipeline : null);
    this._deviceManager.setOnError(this.onErrorCallback);
    this._deviceManager.setOnToast(this.onErrorCallback);
  }

  /** True when an in-flight reconnect attempt for `channelId` has been
   *  superseded and must stop touching shared state: the signal was
   *  aborted, OR a newer connectAndSetup() already claimed `_state` (whether
   *  by moving to "idle"/"connected" for a DIFFERENT channel, or — the
   *  airtight case — by reaching "connected" for the SAME channel, since
   *  connectAndSetup()'s entry-point leaveVoice(false) never runs while
   *  `_room` reads null during "reconnecting" and so never aborts our
   *  signal). State is always "reconnecting" during this loop's own
   *  legitimate run (it only transitions to "connected" at the end of a
   *  successful attempt), so the type check can never false-positive on a
   *  still-current attempt. Checked at every checkpoint in the loop, in the
   *  loop's own state-restore branch, and in the post-loop give-up path. */
  private reconnectSuperseded(signal: AbortSignal, channelId: number): boolean {
    return (
      signal.aborted || this._state.type !== "reconnecting" || this._currentChannelId !== channelId
    );
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
    for (let attempt = 1; attempt <= LiveKitSession.MAX_RECONNECT_ATTEMPTS; attempt++) {
      log.info("Auto-reconnect attempt", {
        attempt,
        maxAttempts: LiveKitSession.MAX_RECONNECT_ATTEMPTS,
      });
      // oxlint-disable-next-line no-await-in-loop -- intentional sequential polling with backoff delay
      await new Promise((r) => setTimeout(r, LiveKitSession.RECONNECT_DELAY_MS));
      // If user manually left or joined a different channel during the delay, abort.
      if (this.reconnectSuperseded(signal, channelId)) {
        log.info("Auto-reconnect aborted — user left or channel changed");
        return;
      }
      // Aliased outside the try so the catch can tear down the attempt's own
      // room: this._room is null while state is "reconnecting".
      let attemptRoom: Room | null = null;
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must create+arm E2EE before connect
        const newRoom = await this.createRoom();
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
          // syncModuleRooms() derives from `_room`, so it correctly nulls the
          // modules when nothing newer has connected yet, and correctly leaves
          // a newer session's wiring alone when one has.
          this.syncModuleRooms();
        };
        // Set state to reconnecting with the fresh room-less attempt info;
        // the actual room appears in "connected" state after connect succeeds.
        if (this._state.type === "reconnecting") {
          this.setState({ ...this._state, ac: this._state.ac });
        }
        this._audioPipeline.setRoom(newRoom);
        this._audioElements.setRoom(newRoom);
        this._deviceManager.setRoom(newRoom);
        this._deviceManager.setAudioPipeline(this._audioPipeline);

        if (this.reconnectSuperseded(signal, channelId)) {
          log.info("Auto-reconnect aborted after room creation");
          await cleanupAbortedReconnect();
          return;
        }

        // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: resolve URL then connect
        const resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);

        if (this.reconnectSuperseded(signal, channelId)) {
          log.info("Auto-reconnect aborted before room connect");
          await cleanupAbortedReconnect();
          return;
        }

        // E2EE: Regenerate ECDH keypair for the new session (forward secrecy)
        // and re-announce so other participants can re-wrap the room key for us.
        // If we still have the room key from before disconnect, re-apply it now
        // so audio works immediately; the key holder will send a fresh offer if
        // the key was rotated during our absence.
        // oxlint-disable-next-line no-await-in-loop -- must set up E2EE before connect
        await this._e2ee.reannounceForReconnect();

        // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must connect before restoring state
        await newRoom.connect(resolvedUrl, token);

        if (this.reconnectSuperseded(signal, channelId)) {
          log.info("Auto-reconnect aborted after room connect");
          await cleanupAbortedReconnect();
          return;
        }

        log.info("Auto-reconnect succeeded", { attempt, channelId, url: resolvedUrl });
        // Transition to "connected" — this is the single atomic write.
        this.setState({
          type: "connected",
          room: newRoom,
          channelId,
          latestToken: token,
          lastUrl: url,
          lastDirectUrl: directUrl,
        });
        setVoiceStatus("connected");
        this._deviceManager.setOnError(this.onErrorCallback);
        this._deviceManager.setOnToast(this.onErrorCallback);
        logIceConnectionInfo(newRoom);
        newRoom
          .startAudio()
          .catch((err) => log.debug("Failed to start audio after reconnect", err));
        // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: must restore voice state after connect
        await this.restoreLocalVoiceState("reconnect");

        // OC-0009: mirrors connectAndSetup's post-connect checkpoints
        // (3/4/5) — this tail keeps awaiting (restoreLocalVoiceState,
        // switchActiveDevice) after already installing "connected" into the
        // shared state, so `reconnectSuperseded` (which expects "reconnecting")
        // can no longer tell a still-current attempt from a superseded one.
        // A newer connectAndSetup()/attemptAutoReconnect() may have since
        // claimed `_state` for a different channel; isStateConnected() reads
        // through a method call so it always sees the live value.
        if (!this.isStateConnected(channelId)) {
          log.info("Auto-reconnect: superseded after restoreLocalVoiceState — aborting tail", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(newRoom);
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

        if (!this.isStateConnected(channelId)) {
          log.info("Auto-reconnect: superseded after audioinput switch — aborting tail", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(newRoom);
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

        if (!this.isStateConnected(channelId)) {
          log.info("Auto-reconnect: superseded after audiooutput switch — aborting tail", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(newRoom);
          return;
        }

        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        // Signal the setReconnectAc callback that the reconnect is done.
        // ac === null clears the pending state in the callback.
        this._pendingReconnectFields = null;
        // Request a fresh token since the stored one may be close to expiry.
        this.requestTokenRefresh();
        return;
      } catch (err) {
        log.warn("Auto-reconnect failed", { attempt, url, error: err });
        // Tear down this attempt's room (this._room is null in "reconnecting"
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
        if (this._state.type === "reconnecting") {
          this.setState({
            type: "reconnecting",
            channelId: this._state.channelId,
            latestToken: this._state.latestToken,
            lastUrl: this._state.lastUrl,
            lastDirectUrl: this._state.lastDirectUrl,
            ac: this._state.ac,
          });
        }
        // See the matching comment in cleanupAbortedReconnect above: sync from
        // the current shared state rather than unconditionally nulling, so a
        // stale failed attempt cannot clobber a newer session's module wiring.
        this.syncModuleRooms();
      }
    }
    // All attempts exhausted — give up and clean up. But first check this
    // loop is still current: the user may have left voice or joined a
    // different channel during the last attempt's delay/connect, in which
    // case `leaveVoice(true)` below would tear down the LIVE session that
    // replaced this one (CLAUDE.md: voice sessions are superseded, not
    // cancelled — cleanup here must be scoped to this attempt, not global).
    // The state-type check is what catches a re-join of the SAME channel:
    // connectAndSetup() overwrites `_state` without aborting our signal (the
    // `_room` getter is null while "reconnecting", so its entry-point
    // leaveVoice(false) never runs), leaving both `signal.aborted` false and
    // `_currentChannelId` equal to ours once that join reaches "connected".
    if (this.reconnectSuperseded(signal, channelId)) {
      log.info("Auto-reconnect give-up skipped — superseded");
      return;
    }
    // Send voice_leave over WS so the server removes our voice state;
    // without this the server and other clients see us as a ghost participant.
    log.error("Auto-reconnect exhausted all attempts, giving up");
    this.leaveVoice(true);
    leaveVoiceChannel();
    this.onErrorCallback?.("Voice connection lost — failed to reconnect");
  }

  // --- URL resolution ---

  private async resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string> {
    if (this.serverHost !== null) {
      // Extract hostname, handling IPv6 bracket notation (e.g. "[::1]:7880")
      // and bare IPv6 (e.g. "::1").
      let host: string;
      if (this.serverHost.startsWith("[")) {
        host = this.serverHost.slice(1, this.serverHost.indexOf("]"));
      } else if ((this.serverHost.match(/:/g) ?? []).length > 1) {
        // Bare IPv6 address (multiple colons, no brackets) — use as-is
        host = this.serverHost;
      } else {
        host = this.serverHost.split(":")[0] ?? "";
      }
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (isLocal && directUrl) {
        log.debug("LiveKit URL resolved via direct (local)", { url: directUrl });
        return directUrl;
      }
      if (proxyPath.startsWith("/")) {
        // Remote server: route through the local Rust TLS proxy so WebView2
        // doesn't reject self-signed certificates on the LiveKit signal WS.
        const port = await this.ensureLiveKitProxy();
        const resolved = `ws://127.0.0.1:${port}${proxyPath}`;
        log.debug("LiveKit URL resolved via TLS proxy", {
          url: resolved,
          remoteHost: this.serverHost,
        });
        return resolved;
      }
    }
    log.debug("LiveKit URL resolved as passthrough", { url: proxyPath });
    return proxyPath;
  }

  /** Start (or reuse) the Rust-side local TCP-to-TLS proxy for LiveKit.
   *
   *  Always invokes start_livekit_proxy — never cache the port here. Only the
   *  Rust side can compare the running proxy's TOFU pin against certs.json,
   *  so after the user accepts a rotated cert a JS port cache would keep
   *  every voice rejoin tunneling into the stale pin until logout. The Rust
   *  reuse branch dedups unchanged host+pin, so the repeat call is cheap. */
  private async ensureLiveKitProxy(): Promise<number> {
    if (this.serverHost === null) throw new Error("no server host for LiveKit proxy");
    // Ensure host:port format — default to 443 (standard HTTPS) when the
    // server is behind a reverse proxy. Without an explicit port, the Rust
    // proxy would default to 8443 which may not be exposed.
    // Handle IPv6: "[::1]:7880" has port, "[::1]" and bare "::1" do not.
    let hostWithPort: string;
    if (this.serverHost.startsWith("[")) {
      // Bracketed IPv6 — check for "]:port" suffix
      hostWithPort = this.serverHost.includes("]:") ? this.serverHost : `${this.serverHost}:443`;
    } else if ((this.serverHost.match(/:/g) ?? []).length > 1) {
      // Bare IPv6 (multiple colons) — wrap in brackets and add default port
      hostWithPort = `[${this.serverHost}]:443`;
    } else {
      hostWithPort = this.serverHost.includes(":") ? this.serverHost : `${this.serverHost}:443`;
    }
    this.liveKitProxyPort = await invoke<number>("start_livekit_proxy", {
      remoteHost: hostWithPort,
    });
    log.info("LiveKit TLS proxy started on localhost", { port: this.liveKitProxyPort });
    return this.liveKitProxyPort;
  }

  // --- Token refresh ---

  /** Token refresh interval: 4 minutes (refresh 1 min before the server's
   *  5-minute TTL expiry — see Server/ws/livekit.go tokenTTL). Must stay
   *  below that TTL or a network blip after minute 5 hands attemptAutoReconnect
   *  an already-expired token and every reconnect attempt fails (OC-0014). */
  private static readonly TOKEN_REFRESH_MS = 4 * 60 * 1000;

  private startTokenRefreshTimer(): void {
    this.clearTokenRefreshTimer();
    this.tokenRefreshTimer = setTimeout(() => {
      this.requestTokenRefresh();
    }, LiveKitSession.TOKEN_REFRESH_MS);
    log.debug("Token refresh timer started", { refreshInMs: LiveKitSession.TOKEN_REFRESH_MS });
  }

  private clearTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer !== null) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    // BUG-146: Also cancel any in-flight refresh response timeout so it does
    // not fire after the session is torn down (leaveVoice / cleanupAll both
    // call this method, so one clearing point covers all cleanup paths).
    if (this.tokenRefreshTimeoutTimer !== null) {
      clearTimeout(this.tokenRefreshTimeoutTimer);
      this.tokenRefreshTimeoutTimer = null;
    }
  }

  private requestTokenRefresh(): void {
    if (this.ws === null || this._room === null) {
      log.debug("Skipping token refresh — no active session");
      return;
    }
    // OC-0029: the server refuses more than 1 voice_token_refresh per 60s
    // per user (ErrCodeRateLimited). requestTokenRefresh() is called both by
    // the routine 4-minute timer and by attemptAutoReconnect's unconditional
    // post-recovery refresh, which can land only seconds after the timer's
    // own refresh — without this guard the second request is rejected and
    // surfaces as a bare "token refresh rate limited" error toast right as
    // the user's call recovers.
    if (Date.now() - this._lastTokenRefreshSentAt < 60_000) {
      log.debug("Skipping token refresh — one was already sent within the last 60s");
      return;
    }
    log.info("Requesting voice token refresh");
    this._lastTokenRefreshSentAt = Date.now();
    this.ws.send({ type: "voice_token_refresh", payload: {} });
    // NOTE: startTokenRefreshTimer is called from handleVoiceTokenRefresh
    // (the server response handler), not here, to avoid scheduling two
    // competing timers per cycle.

    // BUG-146: Arm a 60-second response deadline. If the server never replies,
    // the token stalls silently. On timeout we log a warning and reschedule the
    // next refresh attempt rather than disconnecting — the current live session
    // is unaffected (LiveKit keeps active connections alive beyond token expiry);
    // the risk is only that a network blip during the stale window would fail to
    // reconnect. Reconnecting for a refresh timeout is intentionally NOT done here
    // because the WS connection itself may be degraded; a forced disconnect would
    // make the UX worse than leaving the existing (still-valid) token in place.
    if (this.tokenRefreshTimeoutTimer !== null) {
      clearTimeout(this.tokenRefreshTimeoutTimer);
    }
    this.tokenRefreshTimeoutTimer = setTimeout(() => {
      this.tokenRefreshTimeoutTimer = null;
      log.warn(
        "Voice token refresh timed out — server did not respond within 60 s. " +
          "Rescheduling refresh; existing token remains in use.",
      );
      // Re-arm the next scheduled refresh so the client keeps trying.
      this.startTokenRefreshTimer();
    }, 60_000);
  }

  handleVoiceTokenRefresh(token?: string): void {
    // BUG-146: Cancel the response-deadline timer — the server replied in time.
    if (this.tokenRefreshTimeoutTimer !== null) {
      clearTimeout(this.tokenRefreshTimeoutTimer);
      this.tokenRefreshTimeoutTimer = null;
    }
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
    this.startTokenRefreshTimer();
    log.info("Voice token refreshed, timer restarted");
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
      await room.localParticipant.setMicrophoneEnabled(shouldEnableMicrophone);
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
      setListenOnly(false); // Mic acquired successfully
    } catch (micErr) {
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

  /** Checkpoint cleanup for a superseded connectAndSetup attempt, used at
   *  every "return \"superseded\"" site in that function. By the time one of
   *  these fires, a NEWER attempt may have already claimed `_state` (and torn
   *  down THIS attempt's room via its own entry-point leaveVoice(false)) — so
   *  this must disconnect only the passed-in localRoom and must never call
   *  the global leaveVoice()/touch `_state`, or it tears down whichever
   *  session currently occupies `_state`, which now belongs to the newer
   *  attempt.
   *
   *  OC-0006: also re-syncs the extracted modules (DeviceManager/AudioPipeline
   *  /AudioElements) when nobody newer owns `_state`. Earlier checkpoints
   *  (1/2, the key-exchange failure, and the retry-backoff check) fire before
   *  this attempt ever reaches "connected" — if the supersession was a plain
   *  leaveVoice() (state now "idle") that landed while this attempt's own
   *  lines above had already wired the modules to `localRoom`, that leave's
   *  own syncModuleRooms() ran too early and got undone by the later wiring,
   *  leaving DeviceManager's devicechange listener armed on a Room that will
   *  never connect. The condition is required — an unconditional sync would
   *  null the modules out from under a newer attempt that already ran its own
   *  wiring but has not yet reached "connected" (it never re-wires after that
   *  point). */
  private disconnectSupersededLocalRoom(localRoom: Room): void {
    localRoom.removeAllListeners();
    localRoom.disconnect().catch((err) => log.debug("Failed to disconnect superseded room", err));
    if (this._state.type === "idle") this.syncModuleRooms();
  }

  /** Shared connect-with-retry + post-connect setup used by both the primary
   *  handleVoiceToken path and the pending-join drain loop.
   *  Returns true if the room ended up connected and set up,
   *  false on error, or "superseded" if a newer join generation invalidated
   *  this attempt (caller should re-read pendingJoin immediately). */
  private async connectAndSetup(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<boolean | "superseded"> {
    // Also tear down (and abort) an in-flight reconnect: `_room` reads null
    // for the whole "reconnecting" state, so a join issued while the LiveKit
    // auto-reconnect loop is running would otherwise skip leaveVoice(false)
    // entirely — meaning _e2ee.clearState() never runs, and setupKeyExchange
    // below inherits the PREVIOUS channel's residual _isKeyHolder via its
    // OR-with-server-value guard, joining the new channel as a phantom key
    // holder the server never elected (OC-0020).
    if (this._room !== null || this._state.type === "reconnecting") {
      this.leaveVoice(false);
    } else if (this._state.type === "connecting") {
      // OC-0001: the pending-join drain loop (handleVoiceToken) re-enters
      // this function while `_state` is still "connecting" — there is no
      // room to disconnect and no reconnect AC to abort, so the branch above
      // never fires, but a discarded prior attempt (e.g. the e2ee_timeout /
      // checkpoint-2 queued-join paths below) can still leave residual E2EE
      // state (_isKeyHolder, keypair, peer keys) behind for THIS attempt to
      // inherit via setupKeyExchange's OR-with-server-value guard. Clear it
      // explicitly since leaveVoice() itself never runs on this path.
      this._e2ee.clearState();
    }
    // Draw the next generation from the monotonic instance counter (never
    // re-derived from `_state`) and embed it into the "connecting" state.
    // Any newer call to connectAndSetup() will produce a strictly larger
    // generation, making myGeneration !== currentGeneration at each
    // checkpoint even if this attempt's own state transitioned through
    // "idle" in the meantime.
    const myGeneration = ++this._joinGenerationCounter;
    this.setState({ type: "connecting", pendingJoin: null, joinGeneration: myGeneration });
    // "joining" = connecting to the room; the E2EE "securing" phase is set below.
    setVoiceStatus("joining");
    let resolvedUrl = "";
    // Track the room being built in this attempt so we can disconnect it on
    // supersession without touching the shared state (which may already have
    // been claimed by a newer attempt).
    let localRoom: Room | null = null;
    try {
      localRoom = await this.createRoom();
      this._audioPipeline.setRoom(localRoom);
      this._audioElements.setRoom(localRoom);
      this._deviceManager.setRoom(localRoom);
      this._deviceManager.setAudioPipeline(this._audioPipeline);
      this._deviceManager.setOnError(this.onErrorCallback);
      this._deviceManager.setOnToast(this.onErrorCallback);
      resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);

      // Checkpoint 1: after URL resolution (may be slow for TLS proxy init).
      if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
        log.info("connectAndSetup: superseded after URL resolution — aborting", {
          channelId,
          myGeneration,
          currentGeneration: this._state.type === "connecting" ? this._state.joinGeneration : "n/a",
        });
        this.disconnectSupersededLocalRoom(localRoom);
        return "superseded";
      }

      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 2000;

      // ── Client-side E2EE key exchange (ECDH) ──────────────────────────
      // "securing" — until the room key is ready the call is not yet private.
      // Non-key-holders block here waiting for the key holder's offer (up to
      // ~15s); key holders pass through near-instantly.
      setVoiceStatus("securing");
      const keyExchangeOk = await this._e2ee.setupKeyExchange(isKeyHolder ?? false, channelId);
      if (!keyExchangeOk) {
        // setupKeyExchange() also returns false when clearState() aborted the
        // wait (e.g. a supersession that ran leaveVoice() while we were
        // blocked here) — indistinguishable from a genuine timeout by return
        // value alone. Check ownership before treating it as a real failure:
        // a superseded attempt must not fire a spurious toast, send
        // voice_leave (it carries no channel id and would act on whichever
        // channel the NEWER attempt just joined), or clear the store's
        // currentChannelId that the newer join just set.
        if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
          log.info("connectAndSetup: superseded during key exchange — aborting", {
            channelId,
            myGeneration,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }
        // OC-0010: a channel switch queued during the wait (handleVoiceToken's
        // pendingJoin branch) preserves this attempt's type/joinGeneration, so
        // the ownership check above cannot distinguish it from "no newer join
        // is coming". Treating it as a genuine failure here would send
        // voice_leave with no channel id — deleting the QUEUED join's
        // voice_states row, not this timed-out attempt's — and would drop the
        // pendingJoin itself by transitioning to idle before the drain loop
        // ever reads it. Only run the give-up cleanup when nothing is queued.
        if (this._state.pendingJoin === null) {
          this.onErrorCallback?.("e2ee_timeout");
          // The exchange timed out BEFORE room.connect(): no SFU participant
          // exists, so no LiveKit webhook will ever clean up, and the server
          // registered the join when it sent voice_token. Send voice_leave and
          // leave the store's voice channel (like the reconnect-exhausted give-up
          // path) or the stale row ghosts forever and can wedge the channel's
          // key-holder election.
          this.leaveVoice(true);
          leaveVoiceChannel();
        } else {
          // Leave state as "connecting" with pendingJoin intact so the finally
          // block and handleVoiceToken's drain loop can run the queued join.
          // Clear this attempt's own E2EE residue (keypair/_isKeyHolder/etc.)
          // so the queued join does not inherit it — entry-point leaveVoice(false)
          // never runs for that next call since `_room` is null here (OC-0001).
          this._e2ee.clearState();
        }
        return false;
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential retry: must attempt connect before checking result
          await localRoom.connect(resolvedUrl, token);

          // Checkpoint 2: after room.connect() — the primary race window.
          if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
            log.info("connectAndSetup: superseded after room.connect() — aborting", {
              channelId,
              myGeneration,
              currentGeneration:
                this._state.type === "connecting" ? this._state.joinGeneration : "n/a",
            });
            this.disconnectSupersededLocalRoom(localRoom);
            return "superseded";
          }

          // Belt-and-suspenders: also keep existing pending-join token check
          // for logging clarity when a newer request arrived via pendingJoin.
          const queuedJoin = this._state.type === "connecting" ? this._state.pendingJoin : null;
          if (
            queuedJoin !== null &&
            (queuedJoin.token !== token ||
              queuedJoin.url !== url ||
              queuedJoin.channelId !== channelId ||
              queuedJoin.directUrl !== directUrl)
          ) {
            log.info("Discarding stale voice join in favor of queued request", {
              channelId,
              queuedChannelId: queuedJoin.channelId,
            });
            localRoom.removeAllListeners();
            localRoom
              .disconnect()
              .catch((err) => log.debug("Failed to disconnect room during cleanup", err));
            localRoom = null;
            this._audioPipeline.setRoom(null);
            this._audioElements.setRoom(null);
            this._deviceManager.setRoom(null);
            this._deviceManager.setAudioPipeline(null);
            break;
          }
          break;
        } catch (connectErr) {
          if (attempt < MAX_RETRIES) {
            log.warn("LiveKit connect failed, retrying", {
              attempt,
              maxRetries: MAX_RETRIES,
              url: resolvedUrl,
              error: connectErr,
            });
            // oxlint-disable-next-line no-await-in-loop -- intentional backoff delay between retry attempts
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            // Generation check inside retry loop: a superseding join may arrive
            // during the backoff delay.
            if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
              log.info("connectAndSetup: superseded during retry backoff — aborting", {
                channelId,
                attempt,
              });
              if (localRoom !== null) this.disconnectSupersededLocalRoom(localRoom);
              return "superseded";
            }
            if (localRoom === null) throw connectErr;
            localRoom.removeAllListeners();
            // oxlint-disable-next-line no-await-in-loop -- sequential retry: must arm E2EE before the next connect attempt
            localRoom = await this.createRoom();
            this._audioPipeline.setRoom(localRoom);
            this._audioElements.setRoom(localRoom);
            this._deviceManager.setRoom(localRoom);
            this._deviceManager.setAudioPipeline(this._audioPipeline);
          } else {
            throw connectErr;
          }
        }
      }
      // If the room was discarded (stale join superseded by pending), skip setup.
      if (localRoom !== null) {
        log.info("Connected to LiveKit room", { channelId, url: resolvedUrl });
        logIceConnectionInfo(localRoom);
        // Atomic transition to "connected" — all connection fields set together.
        this.setState({
          type: "connected",
          room: localRoom,
          channelId,
          latestToken: token,
          lastUrl: url,
          lastDirectUrl: directUrl,
        });
        // Room connected and E2EE key ready — the call is now secured.
        setVoiceStatus("connected");
        // Optimistic startAudio — may succeed if the join was triggered by a
        // recent user gesture. If not, the AudioPlaybackStatusChanged handler
        // will register a click-to-unlock fallback.
        localRoom.startAudio().catch(() => {
          log.debug("Optimistic startAudio failed — waiting for user gesture");
        });
        await this.restoreLocalVoiceState("join");

        // Checkpoint 3: after restoreLocalVoiceState (mic acquisition can be slow).
        // Cast to SessionState to escape TS control-flow narrowing that incorrectly
        // assumes _state is still "connecting" (it was set to "connected" above, but
        // TS cannot see through the setState() opaque method call).
        if (!this.isStateConnected(channelId)) {
          log.info("connectAndSetup: superseded after restoreLocalVoiceState — aborting", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }

        const savedInput = loadPref<string>("audioInputDevice", "");
        if (savedInput) {
          try {
            await localRoom.switchActiveDevice("audioinput", savedInput);
          } catch (err) {
            log.warn("Saved input device unavailable, using default", err);
          }
        }

        // Checkpoint 4: after audioinput switchActiveDevice.
        if (!this.isStateConnected(channelId)) {
          log.info("connectAndSetup: superseded after audioinput switch — aborting", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }

        const savedOutput = loadPref<string>("audioOutputDevice", "");
        if (savedOutput) {
          try {
            await localRoom.switchActiveDevice("audiooutput", savedOutput);
          } catch (err) {
            log.warn("Saved output device unavailable, using default", err);
          }
        }

        // Checkpoint 5: after audiooutput switchActiveDevice.
        if (!this.isStateConnected(channelId)) {
          log.info("connectAndSetup: superseded after audiooutput switch — aborting", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }

        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        log.info("Voice session active", { channelId });
        return true;
      }
      return false;
    } catch (err) {
      log.error("Failed to connect to LiveKit", { url: resolvedUrl, error: err });
      if (localRoom !== null) {
        // Drop this attempt's listeners BEFORE disconnecting: handleDisconnected
        // acts on the shared session state, so a failed attempt's Disconnected
        // event would otherwise tear down (or spawn a reconnect loop for)
        // whichever session owns `_state` by then — which, when this attempt
        // has been superseded, is a live one that belongs to a newer join.
        localRoom.removeAllListeners();
        try {
          void localRoom.disconnect();
        } catch {
          /* ignore */
        }
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      // Only touch the shared session state if this attempt is still current.
      // A superseded attempt must not clear a newer join's server-side voice
      // membership — leaveVoice's voice_leave frame carries no channel id and
      // acts on whichever channel the user currently occupies, so sending it
      // here for a stale attempt would delete the NEW join's voice_states row
      // — nor reset a live session back to idle (CLAUDE.md: voice sessions are
      // superseded, not cancelled).
      if (
        this._state.type === "connecting" &&
        this._state.joinGeneration === myGeneration &&
        this._state.pendingJoin === null
      ) {
        // The connect attempt failed entirely: no SFU participant was ever
        // created, so no LiveKit webhook will ever clean up, and the server
        // already registered the join when it sent voice_token. Send
        // voice_leave and leave the store's voice channel (mirroring the
        // e2ee-timeout and reconnect-exhausted give-up paths) or the stale
        // voice_states row ghosts forever and can wedge the channel's
        // key-holder election.
        this.leaveVoice(true);
        leaveVoiceChannel();
      }
      return false;
    } finally {
      // Only clear "connecting" back to "idle" if we are still in the connecting
      // state for this generation — never overwrite a "connected" state that was
      // set by the success path above (guards against risk #4 in the analysis).
      // If a pendingJoin was queued while this attempt ran, leave the state as
      // "connecting" so handleVoiceToken's drain loop can read and consume it.
      if (this._state.type === "connecting" && this._state.joinGeneration === myGeneration) {
        if (this._state.pendingJoin === null) {
          this.setState({ type: "idle" });
        }
      }
    }
  }

  async handleVoiceToken(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<void> {
    const s = this._state;
    // OC-0015: livekit-client's own internal reconnect (network blip on the
    // SFU signal socket) moves Room.state through "signalReconnecting" /
    // "reconnecting" without ever emitting RoomEvent.Disconnected — the only
    // event this session listens for — so `_state` stays "connected" the
    // whole time. A routine 4-minute refresh token landing in that window
    // must still take the lightweight refresh path instead of falling
    // through to a full teardown+rejoin of a session that is about to
    // recover on its own; only a room the SDK has fully given up on
    // ("disconnected") should be treated as needing a real reconnect here.
    if (s.type === "connected" && s.channelId === channelId && s.room.state !== "disconnected") {
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this._connecting) {
      // Update the pendingJoin on the existing "connecting" state immutably.
      if (this._state.type === "connecting") {
        this.setState({
          ...this._state,
          pendingJoin: { token, url, channelId, directUrl, isKeyHolder },
        });
      }
      log.warn("handleVoiceToken: already connecting, queued latest join request", { channelId });
      return;
    }
    // OC-0009: a voice_token can arrive after the user already left this
    // channel (e.g. Disconnect fired before the voice_join/voice_token round
    // trip returned) — `_state` alone cannot tell, since a leave that landed
    // before any connectAndSetup() ever started leaves `_state` at "idle"
    // either way. voiceStore.currentChannelId is the one place the leave is
    // recorded independent of this session's own lifecycle: joinVoiceChannel()
    // always sets it before the request that produced this token was sent,
    // and leaveVoiceChannel() nulls it, so a mismatch here means the token is
    // stale. Connecting anyway would silently rejoin the SFU and republish
    // the mic for a call the UI, store, and server all consider ended.
    if (voiceStore.getState().currentChannelId !== channelId) {
      log.info("handleVoiceToken: voice_token for a channel we already left — ignoring", {
        channelId,
      });
      return;
    }
    await this.connectAndSetup(token, url, channelId, directUrl, isKeyHolder);
    // Drain pending joins iteratively to avoid unbounded recursion when
    // rapid channel switches queue multiple requests.
    // A "superseded" result means connectAndSetup() already aborted early;
    // we still drain pendingJoin so the latest request always wins.
    let pendingJoin = this._state.type === "connecting" ? this._state.pendingJoin : null;
    if (this._state.type === "connecting") {
      this.setState({ ...this._state, pendingJoin: null });
    }
    while (pendingJoin !== null) {
      const {
        token: pToken,
        url: pUrl,
        channelId: pChannelId,
        directUrl: pDirectUrl,
        isKeyHolder: pIsKeyHolder,
      } = pendingJoin;
      const cur = this._state;
      if (
        cur.type === "connected" &&
        cur.channelId === pChannelId &&
        cur.room.state !== "disconnected"
      ) {
        this.handleVoiceTokenRefresh(pToken);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- sequential drain of pending joins to avoid unbounded recursion
        await this.connectAndSetup(pToken, pUrl, pChannelId, pDirectUrl, pIsKeyHolder);
        // If this attempt was itself superseded (another join arrived during the
        // await), the loop will naturally pick it up via the updated pendingJoin.
      }
      pendingJoin = this._state.type === "connecting" ? this._state.pendingJoin : null;
      if (this._state.type === "connecting") {
        this.setState({ ...this._state, pendingJoin: null });
      }
    }
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
      await room.localParticipant.setMicrophoneEnabled(true);
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
      log.warn("Microphone retry failed — still in listen-only mode", err);
      this.onErrorCallback?.("Microphone still unavailable — check your browser permissions");
    }
  }

  leaveVoice(sendWs = true): void {
    // Cancel any pending auto-reconnect loop first.
    const ac = this._reconnectAc;
    if (ac !== null) {
      ac.abort();
    }
    this._pendingReconnectFields = null;
    this.clearTokenRefreshTimer();
    // OC-0029: a fresh join must never inherit the outgoing session's refresh
    // budget — otherwise a rejoin shortly after a leave could get silently
    // throttled for up to 60s with no refresh sent at all.
    this._lastTokenRefreshSentAt = 0;
    this._audioPipeline.teardownAudioPipeline();
    this._eventHandlers.removeAutoplayUnlock();
    // OC-0042: bump first, mirroring doDisableCamera/doDisableScreenshare —
    // a concurrent enableCamera()/enableScreenshare() still awaiting device
    // acquisition (getUserMedia/getDisplayMedia/publishTrack) when the user
    // leaves voice must detect it was superseded and discard its track
    // instead of publishing onto the room this leave already disconnected.
    bumpGeneration(this._cameraState);
    bumpGeneration(this._screenState);
    // Clean up manually published tracks.
    stopManualCameraTrack(this._cameraState, this._room);
    stopManualScreenTracks(this._screenState, this._room);
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    // Remove orphaned remote audio elements (normally cleaned up by
    // TrackUnsubscribed, but may be missed during rapid reconnection).
    // Full cleanup: also clears screenshare mute state on intentional leave.
    this._audioElements.cleanupAllAudioElementsFull();
    const room = this._room;
    if (room !== null) {
      room.removeAllListeners();
      room.disconnect().catch((err) => log.warn("room.disconnect() error (non-fatal)", err));
    }
    // Clear client-side E2EE state (ECDH keypair, room key, peer keys), and
    // kill the E2EE worker so the last room key does not stay resident in it.
    this._e2ee.clearState();
    this._e2eeWorker?.terminate();
    this._e2eeWorker = null;
    // Transition to idle — atomically clears room, channelId, tokens, reconnectAc,
    // pendingJoin, and the joinGeneration (idle has none). Any in-flight
    // connectAndSetup() will detect the state type change at its next checkpoint.
    this.setState({ type: "idle" });
    setVoiceStatus("idle");
    this.syncModuleRooms();
    setLocalCamera(false);
    setLocalScreenshare(false);
    log.info("Left voice session");
  }

  cleanupAll(): void {
    this.leaveVoice(false);
    // leaveVoice() already transitions state to "idle".
    // Clear non-connection fields (config / callbacks / infrastructure).
    this.onErrorCallback = null;
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
    this.ws = null;
    this.serverHost = null;
    this.liveKitProxyPort = null;
    this._e2ee.clearIdentityKeyPair();
    // Stop the Rust-side TLS proxy (fire-and-forget).
    invoke("stop_livekit_proxy").catch((err) => log.warn("Failed to stop LiveKit proxy", err));
  }

  setMuted(muted: boolean): void {
    // A moderator-imposed mute is not ours to lift. The server only mutes the
    // track SIDs that exist at mute time and the LiveKit grant still carries
    // the microphone publish source, so unmuting here would publish a fresh
    // track the SFU happily forwards — server-side muting relies on the client
    // refusing its own unmute. The guard lives here rather than in the callers
    // because push-to-talk calls straight into this method (ptt.ts), bypassing
    // the voice widget's own check. Muting is always permitted.
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

  /** Nuclear mute: fully unpublish the mic track when muting and tear down
   *  the audio pipeline. Re-publish and rebuild when unmuting. This guarantees
   *  the SFU has no audio track to forward to other participants. */
  private async applyMicMuteState(muted: boolean): Promise<void> {
    const room = this._room;
    if (room === null) return;
    if (muted) {
      // Tear down pipeline first so it doesn't hold refs to the track
      this._audioPipeline.teardownAudioPipeline();
      // Fully disable the mic — this unpublishes the track from the SFU
      await room.localParticipant.setMicrophoneEnabled(false);
      log.debug("Mic fully unpublished (muted)");
    } else {
      // A push-to-talk gate (or, defensively, a moderator's server-mute) is
      // not this call's to lift — setMuted/setDeafened only guard their own
      // flag before calling here, so this is the one place every re-enable
      // path (present and future) shares the full policy check.
      if (isMicPolicyGated()) {
        log.debug("Skipping mic re-publish — still gated (mute/deafen/server-mute/PTT)");
        return;
      }
      // Re-enable mic — this re-publishes the track to the SFU. Every caller
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
        await room.localParticipant.setMicrophoneEnabled(true);
        // Rebuild the audio pipeline on the fresh track
        this._audioPipeline.setupAudioPipeline();
        log.debug("Mic re-published (unmuted)");
      } catch (err) {
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
      outputVolumeMultiplier: this.outputVolumeMultiplier,
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

/** True when the LiveKit session has an active room connection. */
export function isVoiceConnected(): boolean {
  return session.getRoom() !== null;
}

/** True while a join is in flight ("connecting"/"reconnecting") OR a room is
 *  live ("connected") — i.e. there is something for leaveVoice() to tear
 *  down. OC-0249: isVoiceConnected() alone reads false for the entire
 *  "connecting" state (no Room object exists yet), so a caller deciding
 *  whether to abort an in-flight join must ask this instead. */
export function isVoiceSessionActive(): boolean {
  return session.hasActiveSession();
}

export function getRoomForStats(): Room | null {
  return session.getRoom();
}
