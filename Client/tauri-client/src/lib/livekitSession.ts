// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import { Room, RoomEvent, ExternalE2EEKeyProvider } from "livekit-client";
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
import { authStore } from "@stores/auth.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { invoke } from "@tauri-apps/api/core";
import { AudioPipeline } from "@lib/audioPipeline";
import { AudioElements } from "@lib/audioElements";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  generateRoomKey,
  roomKeyToBase64,
  wrapRoomKey,
  unwrapRoomKey,
  signEphemeralKey,
  verifyEphemeralKeySignature,
  importIdentityPublicKey,
  computeKeyFingerprint,
} from "@lib/e2eeCrypto";
import { getOrCreateIdentityKeyPair, getIdentityPin, storeIdentityPin } from "@lib/identity";
import { membersStore } from "@stores/members.store";
import {
  setPeerVerification,
  clearPeerVerification,
  clearPeerVerifications,
} from "@stores/voice.store";
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

  /** E2EE key provider — shared across Room instances. The room key is generated
   *  and exchanged client-side via ECDH; the server never sees it. */
  private _e2eeKeyProvider = new ExternalE2EEKeyProvider();

  // ── Client-side E2EE state (ECDH key exchange) ───────────────────────────
  /** Ephemeral ECDH P-256 keypair for the current voice session. */
  private _ecdhKeyPair: CryptoKeyPair | null = null;
  /** The 256-bit symmetric room key (plaintext). Only held by the key holder
   *  initially; other participants receive it via ECDH-wrapped offers. */
  private _roomKey: Uint8Array | null = null;
  /** Peer ECDH public keys indexed by userId. */
  private _peerPublicKeys: Map<number, CryptoKey> = new Map();
  /** This client's long-term ECDSA identity keypair (F3 TOFU), used to sign our
   *  ephemeral announces. Loaded lazily from the OS keyring, cached per session. */
  private _identityKeyPair: CryptoKeyPair | null = null;
  /** True if this client is the key holder (longest-present participant). */
  private _isKeyHolder = false;
  /** Resolver/rejector for non-key-holders waiting to receive the room key via offer. */
  private _roomKeyResolver: (() => void) | null = null;
  private _roomKeyRejector: ((err: Error) => void) | null = null;
  /** Guard: true while a key rotation is in progress (prevents concurrent rotations). */
  private _rotatingKey = false;
  /** Set when a keyed-peer leave coincides with an in-flight rotation: the rekey
   *  is deferred (not dropped) and re-run when the current rotation finishes, so
   *  a member that left mid-rotation is excluded from the fresh room key. */
  private _rotationPending = false;
  /** Monotonic counter incremented on every key rotation. handleE2EEOffer captures the
   *  epoch before async work and discards the result if epoch changed (stale offer). */
  private _e2eeEpoch = 0;
  /** Announces that arrived before our ECDH keypair was ready. Drained after keypair init. */
  private _pendingAnnounces: Array<{
    userId: number;
    publicKeyBase64: string;
    signatureBase64?: string;
  }> = [];
  /** Periodic key rotation timer — fires every KEY_ROTATION_INTERVAL_MS when key holder. */
  private _keyRotationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Interval between periodic key rotations (5 minutes). */
  private static readonly KEY_ROTATION_INTERVAL_MS = 5 * 60 * 1000;

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
        keyProvider: this._e2eeKeyProvider,
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
      try {
        const newRoom = this.createRoom();
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
        this._ecdhKeyPair = await generateECDHKeyPair();
        this._peerPublicKeys.clear();
        clearPeerVerifications();
        if (this._roomKey) {
          // oxlint-disable-next-line no-await-in-loop -- must set key before connect
          await this._e2eeKeyProvider.setKey(roomKeyToBase64(this._roomKey));
        }
        // oxlint-disable-next-line no-await-in-loop -- must export before connect
        const reconnectPubKey = await exportPublicKey(this._ecdhKeyPair.publicKey);
        // oxlint-disable-next-line no-await-in-loop -- must sign the announce before connect
        const reconnectAnnounce = await this.buildAnnouncePayload(reconnectPubKey);
        this.ws?.send({ type: "voice_e2ee_announce", payload: reconnectAnnounce });

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
        const failedRoom = this._room;
        if (failedRoom !== null) {
          failedRoom.removeAllListeners();
          failedRoom
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

  /** Start (or reuse) the Rust-side local TCP-to-TLS proxy for LiveKit. */
  private async ensureLiveKitProxy(): Promise<number> {
    if (this.liveKitProxyPort !== null) return this.liveKitProxyPort;
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
      this._identityKeyPair = null;
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
      // Generate a fresh ECDH keypair for this session.
      this._ecdhKeyPair = await generateECDHKeyPair();
      this._peerPublicKeys.clear();
      clearPeerVerifications();
      const myPubKeyBase64 = await exportPublicKey(this._ecdhKeyPair.publicKey);
      // Build the signed announce up front — this loads the identity key from
      // the keyring once, so the added identity round-trip does NOT stack on
      // the non-key-holder's 10s key-exchange stall below (F3).
      const announcePayload = await this.buildAnnouncePayload(myPubKeyBase64);

      // Use server-authoritative is_key_holder from voice_token payload.
      this._isKeyHolder = isKeyHolder ?? false;

      // Drain any announces that arrived before our keypair was ready. These
      // are existing participants whose keys the server relayed during
      // voice_join sync — run them through the normal verifying receive path
      // so a server-substituted peer key is caught here too.
      const queued = this._pendingAnnounces.splice(0);
      for (const { userId: qId, publicKeyBase64: qKey, signatureBase64: qSig } of queued) {
        // oxlint-disable-next-line no-await-in-loop -- sequential drain: verify each queued announce
        await this.handleE2EEAnnounce(qId, qKey, qSig);
        log.info("E2EE: drained queued announce", { userId: qId });
      }

      if (this._isKeyHolder) {
        // We're the first participant — generate the room key.
        this._e2eeEpoch++;
        this._roomKey = generateRoomKey();
        await this._e2eeKeyProvider.setKey(roomKeyToBase64(this._roomKey));
        log.info("E2EE: key holder — generated room key", { channelId });
        this.startKeyRotationTimer();
        // Announce our (signed) key so existing participants can see us.
        this.ws?.send({ type: "voice_e2ee_announce", payload: announcePayload });
      } else {
        // Wait for the key holder to send us the room key via voice_e2ee_offer.
        // This promise resolves when handleE2EEOffer() sets _roomKey.
        log.info("E2EE: waiting for room key from key holder", { channelId });
        const roomKeyPromise = new Promise<void>((resolve, reject) => {
          this._roomKeyResolver = resolve;
          this._roomKeyRejector = reject;
        });
        // Announce BEFORE waiting (moved earlier per F3) so the key holder can
        // offer immediately. The resolver is set above, so an immediate offer
        // won't be missed.
        this.ws?.send({ type: "voice_e2ee_announce", payload: announcePayload });
        // Wait up to 10s for the key holder to send an offer. If the first
        // attempt times out, re-announce our public key (the offer may have been
        // lost if the key holder disconnected mid-send) and wait 5s more.
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const makeTimeout = (ms: number) =>
          new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("E2EE key exchange timeout")), ms);
          });
        try {
          await Promise.race([roomKeyPromise, makeTimeout(10_000)]);
        } catch {
          // First attempt timed out — re-announce and retry once.
          if (timeoutId !== null) clearTimeout(timeoutId);
          log.warn("E2EE: first key exchange attempt timed out, re-announcing", { channelId });
          this.ws?.send({ type: "voice_e2ee_announce", payload: announcePayload });
          try {
            await Promise.race([roomKeyPromise, makeTimeout(5_000)]);
          } catch {
            log.error("E2EE: key exchange timed out after retry — disconnecting", { channelId });
            this._roomKeyResolver = null;
            this._roomKeyRejector = null;
            if (timeoutId !== null) clearTimeout(timeoutId);
            this.onErrorCallback?.("e2ee_timeout");
            this.leaveVoice(false);
            return false;
          }
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
        }
        this._roomKeyResolver = null;
        this._roomKeyRejector = null;
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

  // ── Identity signing (F3 TOFU) ──────────────────────────────────────────

  /** Decode a base64 raw-key string to bytes for sign/verify. Throws on bad
   *  input (callers verifying a peer key already run inside try/catch). */
  private rawFromBase64(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  /** Load (once per session) this client's long-term identity keypair from the
   *  OS keyring so we can sign ephemeral announces. Returns null when there is
   *  no server host (identity is host-scoped) — the announce then goes out
   *  unsigned and peers treat us as a legacy/unverified client. */
  private async ensureIdentityKeyPair(): Promise<CryptoKeyPair | null> {
    if (this._identityKeyPair) return this._identityKeyPair;
    if (this.serverHost === null) return null;
    this._identityKeyPair = await getOrCreateIdentityKeyPair(this.serverHost);
    return this._identityKeyPair;
  }

  /** Build the voice_e2ee_announce payload, signing the ephemeral public key
   *  with our identity key (F3). Signing failures degrade to an unsigned
   *  announce rather than blocking the join. */
  private async buildAnnouncePayload(
    ephemeralPubBase64: string,
  ): Promise<{ public_key: string; signature?: string }> {
    try {
      const idKeyPair = await this.ensureIdentityKeyPair();
      if (idKeyPair) {
        const myUserId = authStore.getState().user?.id ?? 0;
        const ephemeralRaw = this.rawFromBase64(ephemeralPubBase64);
        const signature = await signEphemeralKey(idKeyPair.privateKey, myUserId, ephemeralRaw);
        return { public_key: ephemeralPubBase64, signature };
      }
    } catch (err) {
      log.error("E2EE: failed to sign announce — sending unsigned", err);
    }
    return { public_key: ephemeralPubBase64 };
  }

  /**
   * F3 TOFU: resolve a peer's identity key and verify their ephemeral-announce
   * signature. Pins the identity key on first sight; on a later change it emits
   * an identity-tofu "mismatch" (via the voice store) and blocks the peer until
   * the user re-pins. Returns true when the announce may be accepted (verified,
   * or a legacy peer with no identity key), false to reject/block. The store
   * write is the surfaced verification state the voice panel reads.
   *
   * Compatibility posture (transition):
   *   - peer HAS a published identity key, signature missing/invalid → reject
   *     (fail closed);
   *   - peer has NO identity key (legacy client) → accept, mark unverified
   *     (pin-pending).
   */
  private async verifyPeerAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
  ): Promise<boolean> {
    const publishedIdentity =
      membersStore.getState().members.get(userId)?.identityPublicKey ?? null;
    const host = this.serverHost;

    // Resolve the persisted pin FIRST — before any legacy shortcut. A server
    // must not be able to strip a pinned peer's published key (or swap it) to
    // force it back onto the legacy accept path (finding #2: TOFU pin bypass).
    const pin = host ? await getIdentityPin(host, String(userId)) : null;

    // Pinned peer whose delivered key is absent or differs from the pin —
    // possible server MITM. Block until the user re-pins.
    if (pin !== null && publishedIdentity !== pin) {
      setPeerVerification({ userId, status: "mismatch", safetyNumber: null });
      log.error("E2EE: pinned peer identity key missing/changed — blocking (identity-tofu)", {
        userId,
      });
      return false;
    }

    // Genuine legacy peer: never pinned AND no published identity key — accept
    // but mark unverified (pin-pending). This is the only case the compatibility
    // posture keeps open.
    if (!publishedIdentity) {
      setPeerVerification({ userId, status: "unverified", safetyNumber: null });
      log.warn("E2EE: peer has no identity key — accepting as unverified (legacy)", { userId });
      return true;
    }

    // Verify the ephemeral-key signature against the trusted identity key
    // (the pin when we have one, else the first-sight published key).
    const anchorBase64 = pin ?? publishedIdentity;
    const identityKey = await importIdentityPublicKey(anchorBase64);
    const ephemeralRaw = this.rawFromBase64(publicKeyBase64);
    const ok = signatureBase64
      ? await verifyEphemeralKeySignature(identityKey, userId, ephemeralRaw, signatureBase64)
      : false;
    if (!ok) {
      // Fail closed: peer has an identity key but no valid signature (MITM).
      setPeerVerification({ userId, status: "mismatch", safetyNumber: null });
      log.error("E2EE: peer announce signature invalid — rejecting (MITM?)", { userId });
      return false;
    }

    // First sight with a valid signature — pin the identity key now.
    if (pin === null && host) {
      await storeIdentityPin(host, String(userId), publishedIdentity);
      log.info("E2EE: pinned peer identity key on first sight", { userId });
    }
    const safetyNumber = await computeKeyFingerprint(identityKey);
    setPeerVerification({ userId, status: "verified", safetyNumber });
    return true;
  }

  /**
   * F3 TOFU re-pin recovery (finding #4). Pin the EXACT identity key
   * `verifiedKey` — the bytes whose fingerprint the caller displayed and the
   * user confirmed out-of-band — overwriting the stored pin for {host,userId}
   * and clearing the mismatch block (the identity-key analogue of accepting a
   * changed TLS cert). A legitimate key rotation (reinstall / new device /
   * wiped keyring) is thus recoverable instead of a permanent lockout; the next
   * announce re-verifies against the new pin.
   *
   * The verified key MUST be passed in, never re-read from membersStore here:
   * the store is server-writable (a `user_update` mutates it), so re-reading it
   * would let a malicious server swap in an attacker key during the human
   * out-of-band verification window and have us pin THAT — a TOCTOU that
   * silently defeats the mismatch prompt. Returns false when there is no host
   * or no key to pin.
   */
  async rePinPeerIdentity(userId: number, verifiedKey: string): Promise<boolean> {
    const host = this.serverHost;
    if (!host || !verifiedKey) {
      log.warn("E2EE: cannot re-pin peer without a host and the verified identity key", { userId });
      return false;
    }
    await storeIdentityPin(host, String(userId), verifiedKey);
    clearPeerVerification(userId);
    log.info("E2EE: re-pinned peer identity key (TOFU recovery)", { userId });
    return true;
  }

  // ── Client-side E2EE handlers (ECDH key exchange) ───────────────────────

  /**
   * Handle a voice_e2ee_announce from the server — another participant has
   * announced their ECDH public key. Before trusting it we verify the peer's
   * identity-key signature (F3 TOFU): resolve the peer's identity key (pinning
   * it on first sight), reject on mismatch/invalid signature, and only then
   * store the ECDH key + (if key holder) wrap the room key for them. Peers with
   * no published identity key (legacy) are accepted but marked unverified.
   */
  async handleE2EEAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
  ): Promise<void> {
    // Queue if our keypair isn't ready yet (announce arrived during connectAndSetup).
    if (!this._ecdhKeyPair) {
      this._pendingAnnounces.push({ userId, publicKeyBase64, signatureBase64 });
      log.info("E2EE: queued announce (keypair not ready)", { userId });
      return;
    }
    try {
      // ── F3 TOFU verification gate ──────────────────────────────────────
      // Resolve the peer's identity key and verify the announce signature
      // BEFORE storing the ECDH key or wrapping the room key. A malicious
      // server that swaps user_id↔ephemeral-key or forges keys fails here.
      if (!(await this.verifyPeerAnnounce(userId, publicKeyBase64, signatureBase64))) {
        return; // rejected/blocked — do not store or wrap
      }

      // Deduplicate: if the key is identical, skip the import but still
      // re-send the room key offer (the peer may be re-requesting after a
      // missed offer or reconnect).
      const existingKey = this._peerPublicKeys.get(userId);
      let peerKey: CryptoKey;
      let isDuplicate = false;
      if (existingKey) {
        const existingB64 = await exportPublicKey(existingKey);
        if (existingB64 === publicKeyBase64) {
          peerKey = existingKey;
          isDuplicate = true;
          log.debug("E2EE: duplicate announce — will re-send offer if key holder", { userId });
        } else {
          peerKey = await importPublicKey(publicKeyBase64);
          log.warn("E2EE: peer public key changed (reconnect?)", { userId });
        }
      } else {
        peerKey = await importPublicKey(publicKeyBase64);
      }
      if (!isDuplicate) {
        this._peerPublicKeys.set(userId, peerKey);
        log.info("E2EE: received peer public key", { userId });
      }

      // If we're the key holder and have a room key, wrap it for the new peer.
      // Capture keypair + roomKey before async work to avoid null dereference if
      // clearE2EEState() runs concurrently.
      const keypair = this._ecdhKeyPair;
      const currentRoomKey = this._roomKey;
      if (this._isKeyHolder && currentRoomKey && keypair) {
        const { encryptedKey, iv } = await wrapRoomKey(keypair.privateKey, peerKey, currentRoomKey);
        this.ws?.send({
          type: "voice_e2ee_offer",
          payload: { target_user_id: userId, encrypted_key: encryptedKey, iv },
        });
        log.info("E2EE: sent room key offer to peer", { userId });
      }
    } catch (err) {
      log.error("E2EE: failed to handle announce", err);
    }
  }

  /**
   * Handle a voice_e2ee_offer from the server — the key holder has sent us
   * the encrypted room key. Unwrap it and apply to the E2EE key provider.
   */
  async handleE2EEOffer(
    fromUserId: number,
    encryptedKeyBase64: string,
    ivBase64: string,
  ): Promise<void> {
    try {
      const peerKey = this._peerPublicKeys.get(fromUserId);
      if (!peerKey) {
        log.warn("E2EE: received offer from unknown peer", { fromUserId });
        return;
      }
      const keypair = this._ecdhKeyPair;
      if (!keypair) {
        log.warn("E2EE: received offer but no ECDH keypair");
        return;
      }

      // Capture epoch before async work — if a key rotation occurs during
      // unwrap, the epoch will have advanced and we discard this stale result.
      const epochBefore = this._e2eeEpoch;

      const unwrapped = await unwrapRoomKey(
        keypair.privateKey,
        peerKey,
        encryptedKeyBase64,
        ivBase64,
      );

      if (this._e2eeEpoch !== epochBefore) {
        log.info("E2EE: discarding stale offer (epoch changed during unwrap)", {
          fromUserId,
          epochBefore,
          epochNow: this._e2eeEpoch,
        });
        return;
      }

      this._roomKey = unwrapped;
      await this._e2eeKeyProvider.setKey(roomKeyToBase64(this._roomKey));
      log.info("E2EE: room key received and applied", { fromUserId });

      // Resolve the pending connect promise if we were waiting for the key.
      if (this._roomKeyResolver) {
        this._roomKeyResolver();
        this._roomKeyResolver = null;
        this._roomKeyRejector = null;
      }
    } catch (err) {
      log.error("E2EE: failed to handle offer", err);
      // Propagate decryption failure so the waiting connectAndSetup unblocks.
      if (this._roomKeyRejector) {
        this._roomKeyRejector(err instanceof Error ? err : new Error(String(err)));
        this._roomKeyResolver = null;
        this._roomKeyRejector = null;
      }
    }
  }

  /**
   * Handle a participant leaving the voice channel. If we become the new key
   * holder, rotate the room key and distribute to remaining peers. If we are
   * ALREADY the key holder and a peer that held the room key left, we also
   * rotate — so the departed member's copy can no longer decrypt future audio
   * against the untrusted SFU (membership forward secrecy).
   *
   * Key holder election: the participant with the lowest user ID among remaining
   * participants is elected. This is deterministic and does not depend on Map
   * insertion order (which is not guaranteed to match server join order).
   */
  async handleParticipantLeft(userId: number): Promise<void> {
    const hadPeerKey = this._peerPublicKeys.has(userId);
    this._peerPublicKeys.delete(userId);
    clearPeerVerification(userId);

    const channelId = this._currentChannelId;
    if (!channelId) return;

    const state = voiceStore.getState();
    const channelUsers = state.voiceUsers.get(channelId);
    if (!channelUsers || channelUsers.size === 0) return;

    // Elect key holder: lowest user_id among remaining participants.
    let lowestUserId = Infinity;
    for (const uid of channelUsers.keys()) {
      if (uid < lowestUserId) lowestUserId = uid;
    }

    const wasKeyHolder = this._isKeyHolder;
    const myUserId = authStore.getState().user?.id ?? 0;

    if (myUserId !== 0 && lowestUserId === myUserId && !wasKeyHolder) {
      // Prevent concurrent rotations (e.g. two participants leave in rapid succession).
      if (this._rotatingKey) {
        log.warn("E2EE: key rotation already in progress, skipping", { userId, channelId });
        return;
      }
      this._rotatingKey = true;
      this._isKeyHolder = true;
      log.info("E2EE: became key holder after participant left", { userId, channelId });

      // Rotate the room key — generate a new one and distribute to all remaining peers.
      try {
        this._e2eeEpoch++;
        this._roomKey = generateRoomKey();
        await this._e2eeKeyProvider.setKey(roomKeyToBase64(this._roomKey));
        log.info("E2EE: rotated room key", { channelId, epoch: this._e2eeEpoch });

        // Snapshot peers before async loop — new peers that arrive during
        // wrapping are handled by the post-rotation check below.
        const keypair = this._ecdhKeyPair;
        const peersSnapshot = new Map(this._peerPublicKeys);

        if (keypair) {
          for (const [peerId, peerKey] of peersSnapshot) {
            const { encryptedKey, iv } = await wrapRoomKey(
              keypair.privateKey,
              peerKey,
              this._roomKey,
            );
            this.ws?.send({
              type: "voice_e2ee_offer",
              payload: { target_user_id: peerId, encrypted_key: encryptedKey, iv },
            });
          }
          log.info("E2EE: distributed rotated key to peers", {
            peerCount: peersSnapshot.size,
          });

          // H3: Check for peers that arrived during the rotation loop and
          // send them the new key too.
          if (keypair === this._ecdhKeyPair && this._roomKey) {
            for (const [peerId, peerKey] of this._peerPublicKeys) {
              if (!peersSnapshot.has(peerId)) {
                const { encryptedKey, iv } = await wrapRoomKey(
                  keypair.privateKey,
                  peerKey,
                  this._roomKey,
                );
                this.ws?.send({
                  type: "voice_e2ee_offer",
                  payload: { target_user_id: peerId, encrypted_key: encryptedKey, iv },
                });
                log.info("E2EE: sent rotated key to late-arriving peer", { peerId });
              }
            }
          }
        }
      } catch (err) {
        log.error("E2EE: failed to rotate room key", err);
      } finally {
        this._rotatingKey = false;
      }
      // If a keyed peer left while this become-holder rotation was in flight, its
      // rekey was deferred (not dropped) — run it now so the departed member is
      // excluded from the fresh key; otherwise re-arm the periodic timer.
      await this.drainPendingRotationOrArmTimer();
    } else if (wasKeyHolder && hadPeerKey) {
      // Membership forward secrecy: I remain the key holder and a peer that held
      // the room key left, so rotate + redistribute to the CURRENT peer set
      // (which already excludes the leaver, deleted above) — otherwise the
      // departed member keeps a valid room key against the untrusted SFU until
      // the next periodic rotation.
      if (this._rotatingKey) {
        // A rotation is already in flight and may already have sent the current
        // key to this leaver before they left. Don't DROP the rekey (that would
        // leave the departed member holding a live key) — defer it so it re-runs
        // when the in-flight rotation completes, excluding them.
        this._rotationPending = true;
      } else {
        await this.rotateKeyPeriodically();
      }
    }
  }

  // ── Periodic key rotation ──────────────────────────────────────────────────

  /** Start the periodic key rotation timer (only meaningful for key holders). */
  private startKeyRotationTimer(): void {
    this.clearKeyRotationTimer();
    if (!this._isKeyHolder) return;
    this._keyRotationTimer = setTimeout(() => {
      this._keyRotationTimer = null;
      void this.rotateKeyPeriodically();
    }, LiveKitSession.KEY_ROTATION_INTERVAL_MS);
    log.debug("E2EE: key rotation timer started", {
      intervalMs: LiveKitSession.KEY_ROTATION_INTERVAL_MS,
    });
  }

  private clearKeyRotationTimer(): void {
    if (this._keyRotationTimer !== null) {
      clearTimeout(this._keyRotationTimer);
      this._keyRotationTimer = null;
    }
  }

  /** Rotate the room key on a timer tick (forward secrecy improvement). */
  private async rotateKeyPeriodically(): Promise<void> {
    if (!this._isKeyHolder || this._rotatingKey) return;
    const channelId = this._currentChannelId;
    if (!channelId) return;

    this._rotatingKey = true;
    try {
      this._e2eeEpoch++;
      this._roomKey = generateRoomKey();
      await this._e2eeKeyProvider.setKey(roomKeyToBase64(this._roomKey));
      log.info("E2EE: periodic key rotation", { channelId, epoch: this._e2eeEpoch });

      const keypair = this._ecdhKeyPair;
      if (keypair && this._roomKey) {
        for (const [peerId, peerKey] of this._peerPublicKeys) {
          const { encryptedKey, iv } = await wrapRoomKey(
            keypair.privateKey,
            peerKey,
            this._roomKey,
          );
          this.ws?.send({
            type: "voice_e2ee_offer",
            payload: { target_user_id: peerId, encrypted_key: encryptedKey, iv },
          });
        }
        log.info("E2EE: distributed periodically rotated key", {
          peerCount: this._peerPublicKeys.size,
        });
      }
    } catch (err) {
      log.error("E2EE: periodic key rotation failed", err);
    } finally {
      this._rotatingKey = false;
    }

    // Re-arm the periodic timer, or run a rotation deferred by a keyed-peer leave
    // that coincided with this one.
    await this.drainPendingRotationOrArmTimer();
  }

  /** After a rotation completes: if a keyed-peer leave coincided with it (its
   *  rekey was deferred, not dropped), run one more rotation to exclude the
   *  departed member; otherwise re-arm the periodic rotation timer. */
  private async drainPendingRotationOrArmTimer(): Promise<void> {
    if (this._rotationPending) {
      this._rotationPending = false;
      await this.rotateKeyPeriodically();
      return;
    }
    this.startKeyRotationTimer();
  }

  /** Clear all E2EE state (called on voice leave). The long-term identity
   *  keypair is intentionally NOT cleared here — it persists across calls to
   *  the same host (cleared only on host change / cleanupAll). */
  private clearE2EEState(): void {
    this._ecdhKeyPair = null;
    this._roomKey = null;
    this._peerPublicKeys.clear();
    clearPeerVerifications();
    this._isKeyHolder = false;
    this._rotatingKey = false;
    this._rotationPending = false;
    this._e2eeEpoch = 0;
    this._pendingAnnounces.length = 0;
    this.clearKeyRotationTimer();
    // Reject (not resolve) so waiting connectAndSetup sees a failure, not a
    // silent success with no room key.
    if (this._roomKeyRejector) {
      this._roomKeyRejector(new Error("Voice session ended"));
    }
    this._roomKeyResolver = null;
    this._roomKeyRejector = null;
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
    this.clearE2EEState();
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
    this._identityKeyPair = null;
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
