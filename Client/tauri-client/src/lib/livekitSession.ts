// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import { Room, RoomEvent } from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
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
import { DeviceManager } from "@lib/deviceManager";
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

  // --- Non-connection fields (configuration / callbacks / infrastructure) ---
  private ws: WsClient | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private serverHost: string | null = null;
  private onRemoteVideoCallback: RemoteVideoCallback | null = null;
  private onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** BUG-146: Guard timer — fires if the server never responds to voice_token_refresh. */
  private tokenRefreshTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
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

  private createRoom(): Room {
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
        worker: new Worker(new URL("livekit-client/e2ee-worker", import.meta.url)),
      },
    });
    newRoom.on(RoomEvent.TrackSubscribed, this._eventHandlers.handleTrackSubscribed);
    newRoom.on(RoomEvent.TrackUnsubscribed, this._eventHandlers.handleTrackUnsubscribed);
    newRoom.on(RoomEvent.Disconnected, this._eventHandlers.handleDisconnected);
    newRoom.on(RoomEvent.ActiveSpeakersChanged, this._eventHandlers.handleActiveSpeakersChanged);
    newRoom.on(
      RoomEvent.AudioPlaybackStatusChanged,
      this._eventHandlers.handleAudioPlaybackChanged,
    );
    newRoom.on(RoomEvent.LocalTrackPublished, this._eventHandlers.handleLocalTrackPublished);
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
      if (signal.aborted || this._currentChannelId !== channelId) {
        log.info("Auto-reconnect aborted — user left or channel changed");
        return;
      }
      // Aliased outside the try so the catch can tear down the attempt's own
      // room: this._room is null while state is "reconnecting".
      let attemptRoom: Room | null = null;
      try {
        const newRoom = this.createRoom();
        attemptRoom = newRoom;
        const cleanupAbortedReconnect = async (): Promise<void> => {
          newRoom.removeAllListeners();
          try {
            await newRoom.disconnect();
          } catch (disconnectErr) {
            log.warn("Failed to disconnect room after reconnect abort", disconnectErr);
          }
          this._audioPipeline.setRoom(null);
          this._audioElements.setRoom(null);
          this._deviceManager.setRoom(null);
          this._deviceManager.setAudioPipeline(null);
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

        if (signal.aborted || this._currentChannelId !== channelId) {
          log.info("Auto-reconnect aborted after room creation");
          await cleanupAbortedReconnect();
          return;
        }

        // oxlint-disable-next-line no-await-in-loop -- sequential reconnect: resolve URL then connect
        const resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);

        if (signal.aborted || this._currentChannelId !== channelId) {
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

        if (signal.aborted || this._currentChannelId !== channelId) {
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
        // BUG-099: Reapply saved audio devices after reconnect (matches initial join path).
        const savedInput = loadPref<string>("audioInputDevice", "");
        if (savedInput) {
          try {
            await newRoom.switchActiveDevice("audioinput", savedInput);
          } catch (err) {
            log.warn("Reconnect: saved input device unavailable, using default", err);
          }
        }
        const savedOutput = loadPref<string>("audioOutputDevice", "");
        if (savedOutput) {
          try {
            await newRoom.switchActiveDevice("audiooutput", savedOutput);
          } catch (err) {
            log.warn("Reconnect: saved output device unavailable, using default", err);
          }
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
        this._audioPipeline.setRoom(null);
        this._audioElements.setRoom(null);
        this._deviceManager.setRoom(null);
        this._deviceManager.setAudioPipeline(null);
      }
    }
    // All attempts exhausted — give up and clean up.
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

  /** Token refresh interval: 23 hours (refresh 1h before 24h TTL expiry). */
  private static readonly TOKEN_REFRESH_MS = 23 * 60 * 60 * 1000;

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
    log.info("Requesting voice token refresh");
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
    //   - Sessions longer than the 4h TTL remain connected (LiveKit keeps
    //     active connections alive) but lose the ability to reconnect after a
    //     network blip once the original token expires.
    //   - The 23h refresh timer ensures a fresh token is always ready
    //     *before* the original expires, so reconnects within the window work.
    // See also: Server/ws/livekit.go tokenTTL constant.
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
    const muted = state.localMuted || state.localDeafened;
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
    if (this._room !== null) this.leaveVoice(false);
    // Increment the generation counter and embed it into the "connecting" state.
    // Any newer call to connectAndSetup() will produce a larger generation,
    // making myGeneration !== currentGeneration at each checkpoint.
    const prevState = this._state;
    const prevGeneration = prevState.type === "connecting" ? prevState.joinGeneration : 0;
    const myGeneration = prevGeneration + 1;
    this.setState({ type: "connecting", pendingJoin: null, joinGeneration: myGeneration });
    // "joining" = connecting to the room; the E2EE "securing" phase is set below.
    setVoiceStatus("joining");
    let resolvedUrl = "";
    // Track the room being built in this attempt so we can disconnect it on
    // supersession without touching the shared state (which may already have
    // been claimed by a newer attempt).
    let localRoom: Room | null = null;
    try {
      localRoom = this.createRoom();
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
        this.onErrorCallback?.("e2ee_timeout");
        this.leaveVoice(false);
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
            localRoom.removeAllListeners();
            localRoom
              .disconnect()
              .catch((err) => log.debug("Failed to disconnect superseded room", err));
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
              return "superseded";
            }
            if (localRoom === null) throw connectErr;
            localRoom.removeAllListeners();
            localRoom = this.createRoom();
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
          this.leaveVoice(false);
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
          this.leaveVoice(false);
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
          this.leaveVoice(false);
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
        try {
          void localRoom.disconnect();
        } catch {
          /* ignore */
        }
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      this.leaveVoice(false);
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
    if (s.type === "connected" && s.channelId === channelId && s.room.state === "connected") {
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
        cur.room.state === "connected"
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
      const { localDeafened } = voiceStore.getState();
      if (localDeafened) {
        await this.applyMicMuteState(true);
        log.info("Microphone acquired but muted (user is deafened)");
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
    this._audioPipeline.teardownAudioPipeline();
    this._eventHandlers.removeAutoplayUnlock();
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
    // Clear client-side E2EE state (ECDH keypair, room key, peer keys).
    this._e2ee.clearState();
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
    setLocalMuted(muted);
    this.applyMicMuteState(muted).catch((e) => log.warn("applyMicMuteState failed", e));
  }

  setDeafened(deafened: boolean): void {
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
      // Re-enable mic — this re-publishes the track to the SFU
      await room.localParticipant.setMicrophoneEnabled(true);
      // Rebuild the audio pipeline on the fresh track
      this._audioPipeline.setupAudioPipeline();
      log.debug("Mic re-published (unmuted)");
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

export function getRoomForStats(): Room | null {
  return session.getRoom();
}
