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
} from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { invoke } from "@tauri-apps/api/core";
import { AudioPipeline } from "@lib/audioPipeline";
import { AudioElements } from "@lib/audioElements";
import { DeviceManager } from "@lib/deviceManager";
import {
  type VideoTrackDeps,
  type CameraTrackState,
  type ScreenTrackState,
  CAMERA_PRESETS,
  CAMERA_PUBLISH_BITRATES,
  SCREENSHARE_PUBLISH_BITRATES,
  getStreamQuality,
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

/** Parse userId from LiveKit participant identity "user-{id}". Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)$/);
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
};

/** Read pendingJoin from an instance — bypasses TS control-flow narrowing
 *  that incorrectly assumes the field is still null after an async interleave. */
function getPendingJoin(session: LiveKitSession): PendingVoiceJoin | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS narrowing workaround
  return (session as any).pendingJoin as PendingVoiceJoin | null;
}

// --- LiveKitSession class ---

export class LiveKitSession {
  private room: Room | null = null;
  private ws: WsClient | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private currentChannelId: number | null = null;
  private serverHost: string | null = null;
  private onRemoteVideoCallback: RemoteVideoCallback | null = null;
  private onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest token received from server (used for reconnection after token refresh). */
  private latestToken: string | null = null;
  /** Guard: true while handleVoiceToken is connecting — prevents concurrent joins. */
  private connecting = false;
  /** Latest join request received while a connection attempt is already running. */
  private pendingJoin: PendingVoiceJoin | null = null;
  /** Last known LiveKit URL and directUrl for auto-reconnect on unexpected disconnect. */
  private lastUrl: string | null = null;
  private lastDirectUrl: string | undefined = undefined;
  /** Max auto-reconnect attempts before giving up and showing error. */
  private static readonly MAX_RECONNECT_ATTEMPTS = 2;
  private static readonly RECONNECT_DELAY_MS = 3000;
  /** Aborted by leaveVoice() to cancel a pending auto-reconnect loop. */
  private reconnectAc: AbortController | null = null;
  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier = loadPref<number>("outputVolume", 100) / 100;
  /** Cached port for the local LiveKit TLS proxy (Rust-side, for self-signed cert support). */
  private liveKitProxyPort: number | null = null;

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
      getRoom: () => this.room,
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
      getRoom: () => this.room,
      setRoom: (r) => {
        this.room = r;
      },
      getCurrentChannelId: () => this.currentChannelId,
      getAudioElements: () => this._audioElements,
      getOnRemoteVideoCallback: () => this.onRemoteVideoCallback,
      getOnRemoteVideoRemovedCallback: () => this.onRemoteVideoRemovedCallback,
      getOnErrorCallback: () => this.onErrorCallback,
      isConnecting: () => this.connecting,
      getLatestToken: () => this.latestToken,
      getLastUrl: () => this.lastUrl,
      getLastDirectUrl: () => this.lastDirectUrl,
      setReconnectAc: (ac) => {
        this.reconnectAc = ac;
      },
      syncModuleRooms: () => this.syncModuleRooms(),
      teardownForReconnect: () => {
        this._audioPipeline.teardownAudioPipeline();
        this.clearTokenRefreshTimer();
      },
      leaveVoice: (sendWs) => this.leaveVoice(sendWs),
      applyMicMuteState: (muted) => this.applyMicMuteState(muted),
      attemptAutoReconnect: (token, url, channelId, directUrl, signal) =>
        this.attemptAutoReconnect(token, url, channelId, directUrl, signal),
    });
  }

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
        screenShareEncoding: {
          maxBitrate: SCREENSHARE_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 5 : quality === "medium" ? 15 : 30,
        },
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
    this._audioPipeline.setRoom(this.room);
    this._audioElements.setRoom(this.room);
    this._deviceManager.setRoom(this.room);
    this._deviceManager.setAudioPipeline(this.room !== null ? this._audioPipeline : null);
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
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling with backoff delay
      await new Promise((r) => setTimeout(r, LiveKitSession.RECONNECT_DELAY_MS));
      // If user manually left or joined a different channel during the delay, abort.
      if (signal.aborted || this.currentChannelId !== channelId) {
        log.info("Auto-reconnect aborted — user left or channel changed");
        return;
      }
      try {
        this.room = this.createRoom();
        this.syncModuleRooms();
        // eslint-disable-next-line no-await-in-loop -- sequential reconnect: resolve URL then connect
        const resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);
        // eslint-disable-next-line no-await-in-loop -- sequential reconnect: must connect before restoring state
        await this.room.connect(resolvedUrl, token);
        log.info("Auto-reconnect succeeded", { attempt, channelId, url: resolvedUrl });
        logIceConnectionInfo(this.room);
        this.room
          .startAudio()
          .catch((err) => log.debug("Failed to start audio after reconnect", err));
        // eslint-disable-next-line no-await-in-loop -- sequential reconnect: must restore voice state after connect
        await this.restoreLocalVoiceState("reconnect");
        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        // Clear the abort controller after all post-connect work is done so
        // leaveVoice() can still abort during restoreLocalVoiceState above.
        this.reconnectAc = null;
        // Request a fresh token since the stored one may be close to expiry.
        this.requestTokenRefresh();
        return;
      } catch (err) {
        log.warn("Auto-reconnect failed", { attempt, url, error: err });
        if (this.room !== null) {
          this.room.removeAllListeners();
          this.room
            .disconnect()
            .catch((disconnectErr) =>
              log.warn("Failed to disconnect room after reconnect failure", disconnectErr),
            );
          this.room = null;
          this.syncModuleRooms();
        }
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
  }

  private requestTokenRefresh(): void {
    if (this.ws === null || this.room === null) {
      log.debug("Skipping token refresh — no active session");
      return;
    }
    log.info("Requesting voice token refresh");
    this.ws.send({ type: "voice_token_refresh", payload: {} });
    // NOTE: startTokenRefreshTimer is called from handleVoiceTokenRefresh
    // (the server response handler), not here, to avoid scheduling two
    // competing timers per cycle.
  }

  handleVoiceTokenRefresh(token?: string): void {
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
    if (token) {
      this.latestToken = token;
    }
    this.startTokenRefreshTimer();
    log.info("Voice token refreshed, timer restarted");
  }

  // --- Volume helpers ---

  private async restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void> {
    if (this.room === null) return;

    const state = voiceStore.getState();
    const muted = state.localMuted || state.localDeafened;
    const deafened = state.localDeafened;
    const shouldEnableMicrophone = !muted;

    try {
      await this.room.localParticipant.setMicrophoneEnabled(shouldEnableMicrophone);
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
   *  handleVoiceToken path and the pending-join drain loop. Returns true if
   *  the room ended up connected and set up, false otherwise. */
  private async connectAndSetup(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
  ): Promise<boolean> {
    if (this.room !== null) this.leaveVoice(false);
    this.connecting = true;
    let resolvedUrl = "";
    try {
      this.room = this.createRoom();
      this.syncModuleRooms();
      resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 2000;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential retry: must attempt connect before checking result
          await this.room.connect(resolvedUrl, token);
          // Check if a newer join was queued during the async connect.
          const queuedJoin = getPendingJoin(this);
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
            if (this.room !== null) {
              const room = this.room;
              this.room = null;
              this.syncModuleRooms();
              room.removeAllListeners();
              room
                .disconnect()
                .catch((err) => log.debug("Failed to disconnect room during cleanup", err));
            }
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
            // eslint-disable-next-line no-await-in-loop -- intentional backoff delay between retry attempts
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            if (this.room === null) throw connectErr;
            this.room.removeAllListeners();
            this.room = this.createRoom();
            this.syncModuleRooms();
          } else {
            throw connectErr;
          }
        }
      }
      // If the room was discarded (stale join superseded by pending), skip setup.
      if (this.room !== null) {
        log.info("Connected to LiveKit room", { channelId, url: resolvedUrl });
        logIceConnectionInfo(this.room);
        this.currentChannelId = channelId;
        this.latestToken = token;
        this.lastUrl = url;
        this.lastDirectUrl = directUrl;
        // Optimistic startAudio — may succeed if the join was triggered by a
        // recent user gesture. If not, the AudioPlaybackStatusChanged handler
        // will register a click-to-unlock fallback.
        this.room.startAudio().catch(() => {
          log.debug("Optimistic startAudio failed — waiting for user gesture");
        });
        await this.restoreLocalVoiceState("join");
        const savedInput = loadPref<string>("audioInputDevice", "");
        if (savedInput) {
          try {
            await this.room.switchActiveDevice("audioinput", savedInput);
          } catch (err) {
            log.warn("Saved input device unavailable, using default", err);
          }
        }
        const savedOutput = loadPref<string>("audioOutputDevice", "");
        if (savedOutput) {
          try {
            await this.room.switchActiveDevice("audiooutput", savedOutput);
          } catch (err) {
            log.warn("Saved output device unavailable, using default", err);
          }
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
      if (this.room !== null) {
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      this.leaveVoice(false);
      return false;
    } finally {
      this.connecting = false;
    }
  }

  async handleVoiceToken(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
  ): Promise<void> {
    if (
      this.room !== null &&
      this.currentChannelId === channelId &&
      this.room.state === "connected"
    ) {
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this.connecting) {
      this.pendingJoin = { token, url, channelId, directUrl };
      log.warn("handleVoiceToken: already connecting, queued latest join request", { channelId });
      return;
    }
    await this.connectAndSetup(token, url, channelId, directUrl);
    // Drain pending joins iteratively to avoid unbounded recursion when
    // rapid channel switches queue multiple requests.
    let pendingJoin = this.pendingJoin;
    this.pendingJoin = null;
    while (pendingJoin !== null) {
      const {
        token: pToken,
        url: pUrl,
        channelId: pChannelId,
        directUrl: pDirectUrl,
      } = pendingJoin;
      if (
        this.room !== null &&
        this.currentChannelId === pChannelId &&
        this.room.state === "connected"
      ) {
        this.handleVoiceTokenRefresh(pToken);
      } else {
        // eslint-disable-next-line no-await-in-loop -- sequential drain of pending joins to avoid unbounded recursion
        await this.connectAndSetup(pToken, pUrl, pChannelId, pDirectUrl);
      }
      pendingJoin = this.pendingJoin;
      this.pendingJoin = null;
    }
  }

  /** Retry microphone permission after being in listen-only mode. */
  async retryMicPermission(): Promise<void> {
    if (this.room === null) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true);
      setListenOnly(false);
      setLocalMuted(false);
      log.info("Microphone permission granted — exited listen-only mode");
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
    // Cancel any pending auto-reconnect loop first
    if (this.reconnectAc !== null) {
      this.reconnectAc.abort();
      this.reconnectAc = null;
    }
    this.clearTokenRefreshTimer();
    this._audioPipeline.teardownAudioPipeline();
    this._eventHandlers.removeAutoplayUnlock();
    this.pendingJoin = null;
    // Clean up manually published tracks.
    stopManualCameraTrack(this._cameraState, this.room);
    stopManualScreenTracks(this._screenState, this.room);
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    // Remove orphaned remote audio elements (normally cleaned up by
    // TrackUnsubscribed, but may be missed during rapid reconnection).
    // Full cleanup: also clears screenshare mute state on intentional leave.
    this._audioElements.cleanupAllAudioElementsFull();
    if (this.room !== null) {
      const r = this.room;
      this.room = null;
      this.syncModuleRooms();
      r.removeAllListeners();
      r.disconnect().catch((err) => log.warn("room.disconnect() error (non-fatal)", err));
    }
    this.currentChannelId = null;
    this.latestToken = null;
    this.lastUrl = null;
    this.lastDirectUrl = undefined;
    setLocalCamera(false);
    setLocalScreenshare(false);
    log.info("Left voice session");
  }

  cleanupAll(): void {
    this.leaveVoice(false);
    this.onErrorCallback = null;
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
    this.ws = null;
    this.serverHost = null;
    this.liveKitProxyPort = null;
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
    if (this.room === null) return;
    if (muted) {
      // Tear down pipeline first so it doesn't hold refs to the track
      this._audioPipeline.teardownAudioPipeline();
      // Fully disable the mic — this unpublishes the track from the SFU
      await this.room.localParticipant.setMicrophoneEnabled(false);
      log.debug("Mic fully unpublished (muted)");
    } else {
      // Re-enable mic — this re-publishes the track to the SFU
      await this.room.localParticipant.setMicrophoneEnabled(true);
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
    return doGetLocalCameraStream(this.room);
  }

  getLocalScreenshareStream(): MediaStream | null {
    return doGetLocalScreenshareStream(this.room);
  }

  /** Get a remote participant's video MediaStream by userId and track type. Returns null if not available. */
  getRemoteVideoStream(userId: number, type: "camera" | "screenshare"): MediaStream | null {
    return doGetRemoteVideoStream(this.room, userId, type);
  }

  getRoom(): Room | null {
    return this.room;
  }

  getSessionDebugInfo(): Record<string, unknown> {
    return buildSessionDebugInfo({
      room: this.room,
      currentChannelId: this.currentChannelId,
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
export const clearOnError = session.clearOnError.bind(session);
export const setOnRemoteVideo = session.setOnRemoteVideo.bind(session);
export const setOnRemoteVideoRemoved = session.setOnRemoteVideoRemoved.bind(session);
export const clearOnRemoteVideo = session.clearOnRemoteVideo.bind(session);
export const handleVoiceToken = session.handleVoiceToken.bind(session);
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
export const muteScreenshareAudio = session.muteScreenshareAudio.bind(session);
export const getScreenshareAudioMuted = session.getScreenshareAudioMuted.bind(session);

/** True when the LiveKit session has an active room connection. */
export function isVoiceConnected(): boolean {
  return session.getRoom() !== null;
}

export function getRoomForStats(): Room | null {
  return session.getRoom();
}
