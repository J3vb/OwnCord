// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  ScreenSharePresets,
  createLocalScreenTracks,
  createLocalVideoTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
  type LocalVideoTrack,
  type LocalTrack,
  type LocalTrackPublication,
  type VideoCaptureOptions,
  type ScreenShareCaptureOptions,
  DisconnectReason,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
  setSpeakers,
  leaveVoiceChannel,
  setListenOnly,
} from "@stores/voice.store";
import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { invoke } from "@tauri-apps/api/core";
import { AudioPipeline } from "@lib/audioPipeline";
import { AudioElements } from "@lib/audioElements";
import { DeviceManager } from "@lib/deviceManager";

const log = createLogger("livekitSession");

// --- Stream quality presets ---

export type StreamQuality = "low" | "medium" | "high" | "source";

const CAMERA_PRESETS: Record<StreamQuality, VideoCaptureOptions> = {
  low:    { resolution: VideoPresets.h360.resolution },
  medium: { resolution: VideoPresets.h720.resolution },
  high:   { resolution: VideoPresets.h1080.resolution },
  source: { resolution: VideoPresets.h1080.resolution },
};

const CAMERA_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low:    600_000,
  medium: 1_700_000,
  high:   4_000_000,
  source: 8_000_000,
};

const SCREENSHARE_PRESETS: Record<StreamQuality, ScreenShareCaptureOptions> = {
  low:    { audio: true, resolution: ScreenSharePresets.h720fps5.resolution },
  medium: { audio: true, resolution: ScreenSharePresets.h1080fps15.resolution, contentHint: "detail" },
  high:   { audio: true, resolution: ScreenSharePresets.h1080fps30.resolution, contentHint: "detail" },
  source: { audio: true, contentHint: "detail" },  // no resolution cap — use native source resolution
};

const SCREENSHARE_PUBLISH_BITRATES: Record<StreamQuality, number> = {
  low:    1_500_000,
  medium: 3_000_000,
  high:   6_000_000,
  source: 10_000_000,
};

function getStreamQuality(): StreamQuality {
  const saved = loadPref<string>("streamQuality", "high");
  if (saved === "low" || saved === "medium" || saved === "high" || saved === "source") return saved;
  return "high";
}

// --- Pure helpers (no instance state) ---

/** Parse userId from LiveKit participant identity "user-{id}". Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)$/);
  if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
  return 0;
}

// --- Types ---

type RemoteVideoCallback = (userId: number, stream: MediaStream, isScreenshare: boolean) => void;
type RemoteVideoRemovedCallback = (userId: number, isScreenshare: boolean) => void;
type PendingVoiceJoin = {
  readonly token: string;
  readonly url: string;
  readonly channelId: number;
  readonly directUrl?: string;
};

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
  // Remote mic + screenshare audio elements are now managed by _audioElements module.
  /** Cached port for the local LiveKit TLS proxy (Rust-side, for self-signed cert support). */
  private liveKitProxyPort: number | null = null;
  // Screenshare mute state is now managed by _audioElements module.

  // --- Extracted modules (facade pattern) ---
  private _audioPipeline = new AudioPipeline();
  private _audioElements = new AudioElements();
  private _deviceManager = new DeviceManager();

  /** Manually published local tracks (camera/screenshare) for explicit cleanup. */
  private manualCameraTrack: LocalVideoTrack | null = null;
  private manualScreenTracks: LocalTrack[] = [];

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
    newRoom.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    newRoom.on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    newRoom.on(RoomEvent.Disconnected, this.handleDisconnected);
    newRoom.on(RoomEvent.ActiveSpeakersChanged, this.handleActiveSpeakersChanged);
    newRoom.on(RoomEvent.AudioPlaybackStatusChanged, this.handleAudioPlaybackChanged);
    newRoom.on(RoomEvent.LocalTrackPublished, this.handleLocalTrackPublished);

    // Room lifecycle event logging for diagnostics
    newRoom.on(RoomEvent.Reconnecting, () => {
      log.warn("LiveKit room reconnecting");
    });
    newRoom.on(RoomEvent.Reconnected, () => {
      log.info("LiveKit room reconnected");
    });
    newRoom.on(RoomEvent.SignalReconnecting, () => {
      log.debug("LiveKit signal reconnecting");
    });
    newRoom.on(RoomEvent.MediaDevicesError, (error: Error) => {
      log.error("LiveKit media device error", { error: error.message });
    });
    newRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) {
        log.debug("Local connection quality changed", { quality });
      }
    });

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

  // --- Room event handlers (arrow fns to preserve `this`) ---

  /** Defense in depth: when LiveKit (re)publishes a mic track during
   *  renegotiation, re-enforce the current mute state on the new track. */
  private handleLocalTrackPublished = (publication: LocalTrackPublication): void => {
    if (publication.source === Track.Source.Microphone) {
      const { localMuted, localDeafened } = voiceStore.getState();
      if (localMuted || localDeafened) {
        this.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed", e));
        log.debug("LocalTrackPublished: re-applied mute to mic track");
      }
    }
  };

  private handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      this._audioElements.handleTrackSubscribedAudio(track, publication, participant);
    } else if (track.kind === Track.Kind.Video) {
      if (userId > 0 && this.onRemoteVideoCallback !== null) {
        const stream = new MediaStream([track.mediaStreamTrack]);
        const isScreenshare = publication.source === Track.Source.ScreenShare;
        this.onRemoteVideoCallback(userId, stream, isScreenshare);
      }
      log.debug("Remote video track subscribed", { userId, trackSid: track.sid });
    }
  };

  private handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      this._audioElements.handleTrackUnsubscribedAudio(track, publication, participant);
    } else if (track.kind === Track.Kind.Video) {
      track.detach();
      const isScreenshare = publication.source === Track.Source.ScreenShare;
      if (userId > 0) this.onRemoteVideoRemovedCallback?.(userId, isScreenshare);
      log.debug("Remote video track unsubscribed", { userId, trackSid: track.sid });
    }
  };

  /** LiveKit's built-in speaking detection — replaces custom RMS polling. */
  private handleActiveSpeakersChanged = (speakers: Participant[]): void => {
    if (this.currentChannelId === null) return;
    const speakerIds: number[] = [];
    for (const speaker of speakers) {
      const userId = parseUserId(speaker.identity);
      if (userId > 0) speakerIds.push(userId);
    }
    speakerIds.sort((x, y) => x - y);
    setSpeakers({ channel_id: this.currentChannelId, speakers: speakerIds });
  };

  /**
   * Autoplay unlock: browsers block audio playback without user interaction.
   * When LiveKit reports audio can't play, we register a one-time click handler
   * on document that calls room.startAudio() — the next click anywhere unlocks audio.
   */
  private autoplayUnlockHandler: (() => void) | null = null;

  private handleAudioPlaybackChanged = (): void => {
    if (this.room === null) return;
    if (this.room.canPlaybackAudio) {
      log.info("Audio playback is now allowed");
      this.removeAutoplayUnlock();
      return;
    }
    log.warn("Audio playback blocked by browser — registering click-to-unlock");
    // Remove previous handler if any, then register a new one
    this.removeAutoplayUnlock();
    this.autoplayUnlockHandler = () => {
      if (this.room !== null) {
        void this.room.startAudio().then(() => {
          log.info("Audio playback unlocked via user gesture");
        });
      }
      this.removeAutoplayUnlock();
    };
    document.addEventListener("click", this.autoplayUnlockHandler, { once: true });
  };

  private removeAutoplayUnlock(): void {
    if (this.autoplayUnlockHandler !== null) {
      document.removeEventListener("click", this.autoplayUnlockHandler);
      this.autoplayUnlockHandler = null;
    }
  }

  private handleDisconnected = (reason?: DisconnectReason): void => {
    log.info("LiveKit room disconnected", { reason });
    // During the initial connect/retry loop in handleVoiceToken, let that loop
    // handle failures. If we run leaveVoice() here it nulls this.room, which
    // causes the retry loop to abort immediately (this.room === null guard).
    if (this.connecting) {
      log.info("Disconnect during initial connect — deferring to retry loop");
      return;
    }
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    if (isUnexpected && this.latestToken !== null && this.currentChannelId !== null && this.lastUrl !== null) {
      // Attempt auto-reconnect with stored token before giving up.
      const token = this.latestToken;
      const url = this.lastUrl;
      const channelId = this.currentChannelId;
      const directUrl = this.lastDirectUrl;
      // Clean up current room without sending WS leave (we're reconnecting, not leaving).
      this._audioPipeline.teardownAudioPipeline();
      this.removeAutoplayUnlock();
      this.clearTokenRefreshTimer();
      // Clear stale remote audio elements so reconnect doesn't leak DOM nodes.
      this._audioElements.cleanupAllAudioElements();
      if (this.room !== null) {
        const r = this.room;
        this.room = null;
        this.syncModuleRooms();
        r.removeAllListeners();
        r.disconnect().catch((err) => log.warn("Failed to disconnect stale room", err));
      }
      this.reconnectAc = new AbortController();
      void this.attemptAutoReconnect(token, url, channelId, directUrl, this.reconnectAc.signal);
      return;
    }
    this.leaveVoice(false);
    leaveVoiceChannel();
    if (isUnexpected) this.onErrorCallback?.("Voice connection lost — disconnected");
  };

  /** Attempt to auto-reconnect after unexpected disconnect using stored token.
   *  The signal is aborted by leaveVoice() to cancel the loop when the user
   *  voluntarily leaves voice during the reconnect delay. */
  private async attemptAutoReconnect(
    token: string, url: string, channelId: number, directUrl: string | undefined, signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; attempt <= LiveKitSession.MAX_RECONNECT_ATTEMPTS; attempt++) {
      log.info("Auto-reconnect attempt", { attempt, maxAttempts: LiveKitSession.MAX_RECONNECT_ATTEMPTS });
      await new Promise((r) => setTimeout(r, LiveKitSession.RECONNECT_DELAY_MS));
      // If user manually left or joined a different channel during the delay, abort.
      if (signal.aborted || this.currentChannelId !== channelId) {
        log.info("Auto-reconnect aborted — user left or channel changed");
        return;
      }
      try {
        this.room = this.createRoom();
        this.syncModuleRooms();
        const resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);
        await this.room.connect(resolvedUrl, token);
        log.info("Auto-reconnect succeeded", { attempt, channelId, url: resolvedUrl });
        this.logIceConnectionInfo();
        this.room.startAudio().catch((err) => log.debug("Failed to start audio after reconnect", err));
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
          this.room.disconnect().catch((err) => log.warn("Failed to disconnect room after reconnect failure", err));
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
      const host = this.serverHost.split(":")[0] ?? "";
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
        log.debug("LiveKit URL resolved via TLS proxy", { url: resolved, remoteHost: this.serverHost });
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
    const hostWithPort = this.serverHost.includes(":") ? this.serverHost : `${this.serverHost}:443`;
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

  /** Compute the effective volume for a participant: per-user volume * master output. */
  private getEffectiveVolume(userId: number): number {
    return this._audioElements.getEffectiveVolume(userId);
  }

  private getScreenshareOutputVolume(): number {
    return Math.max(0, Math.min(1, this.outputVolumeMultiplier));
  }

  private getLocalVoiceFlags(): { muted: boolean; deafened: boolean } {
    const state = voiceStore.getState();
    return {
      muted: state.localMuted || state.localDeafened,
      deafened: state.localDeafened,
    };
  }

  private applyRemoteAudioSubscriptionState(deafened: boolean): void {
    this._audioElements.applyRemoteAudioSubscriptionState(deafened);
  }

  private async restoreLocalVoiceState(mode: "join" | "reconnect"): Promise<void> {
    if (this.room === null) return;

    const { muted, deafened } = this.getLocalVoiceFlags();
    const shouldEnableMicrophone = !muted;

    try {
      await this.room.localParticipant.setMicrophoneEnabled(shouldEnableMicrophone);
      if (shouldEnableMicrophone) {
        log.info(mode === "join"
          ? "Published mic via LiveKit native capture"
          : "Auto-reconnect restored live microphone");
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
      this.applyMicMuteState(true).catch((e) => log.warn("applyMicMuteState failed in restoreLocalVoiceState", e));
    }

    this.applyRemoteAudioSubscriptionState(deafened);
  }

  /** Apply effective volume to all remote participants. */
  private applyAllVolumes(): void {
    this._audioElements.applyAllVolumes();
  }

  // --- Public API ---

  setWsClient(client: WsClient): void { this.ws = client; }
  setServerHost(host: string): void { this.serverHost = host; }
  setOnError(cb: (message: string) => void): void {
    this.onErrorCallback = cb;
    this._deviceManager.setOnError(cb);
  }
  clearOnError(): void {
    this.onErrorCallback = null;
    this._deviceManager.setOnError(null);
  }
  setOnRemoteVideo(cb: RemoteVideoCallback): void { this.onRemoteVideoCallback = cb; }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void { this.onRemoteVideoRemovedCallback = cb; }

  clearOnRemoteVideo(): void {
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
  }

  async handleVoiceToken(
    token: string, url: string, channelId: number, directUrl?: string,
  ): Promise<void> {
    if (this.room !== null && this.currentChannelId === channelId
        && this.room.state === "connected") {
      // handleVoiceTokenRefresh internally calls startTokenRefreshTimer,
      // so we must NOT call startTokenRefreshTimer again after this.
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this.connecting) {
      this.pendingJoin = { token, url, channelId, directUrl };
      log.warn("handleVoiceToken: already connecting, queued latest join request", { channelId });
      return;
    }
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
          await this.room.connect(resolvedUrl, token);
          const queuedJoin = this.pendingJoin;
          if (queuedJoin !== null
              && (queuedJoin.token !== token
                || queuedJoin.url !== url
                || queuedJoin.channelId !== channelId
                || queuedJoin.directUrl !== directUrl)) {
            log.info("Discarding stale voice join in favor of queued request", {
              channelId,
              queuedChannelId: queuedJoin.channelId,
            });
            if (this.room !== null) {
              const room = this.room;
              this.room = null;
              this.syncModuleRooms();
              room.removeAllListeners();
              room.disconnect().catch((err) => log.debug("Failed to disconnect room during cleanup", err));
            }
            // Don't return — fall through to finally + pending-join dispatch.
            break;
          }
          break;
        } catch (connectErr) {
          if (attempt < MAX_RETRIES) {
            log.warn("LiveKit connect failed, retrying", { attempt, maxRetries: MAX_RETRIES, url: resolvedUrl, error: connectErr });
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
        this.logIceConnectionInfo();
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
        // Set up unified audio pipeline (input volume + VAD gating via GainNode).
        // VAD polling only starts if saved sensitivity < 100.
        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        log.info("Voice session active", { channelId });
      }
    } catch (err) {
      log.error("Failed to connect to LiveKit", { url: resolvedUrl, error: err });
      if (this.room !== null) {
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      this.leaveVoice(false);
    } finally {
      this.connecting = false;
    }
    // Dispatch pending join *after* the try/finally so that a throw inside
    // the recursive call doesn't interfere with the outer finally's flag reset.
    const pendingJoin = this.pendingJoin;
    this.pendingJoin = null;
    if (pendingJoin !== null) {
      await this.handleVoiceToken(
        pendingJoin.token,
        pendingJoin.url,
        pendingJoin.channelId,
        pendingJoin.directUrl,
      );
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
    this.removeAutoplayUnlock();
    this.pendingJoin = null;
    // Clean up manually published tracks.
    if (this.manualCameraTrack !== null) { this.manualCameraTrack.stop(); this.manualCameraTrack = null; }
    for (const t of this.manualScreenTracks) t.stop();
    this.manualScreenTracks = [];
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    // Remove orphaned remote audio elements (normally cleaned up by
    // TrackUnsubscribed, but may be missed during rapid reconnection).
    this._audioElements.cleanupAllAudioElements();
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
    this.applyRemoteAudioSubscriptionState(deafened);
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
    if (this.room === null || this.ws === null) {
      log.warn("Cannot enable camera: no active voice session");
      this.onErrorCallback?.("Join a voice channel first");
      return;
    }
    setLocalCamera(true);
    const quality = getStreamQuality();
    try {
      const savedVideoDevice = loadPref<string>("videoInputDevice", "");
      // Stop any existing manual camera track before creating a new one.
      this.stopManualCameraTrack();
      const videoTrack = await createLocalVideoTrack({
        ...CAMERA_PRESETS[quality],
        ...(savedVideoDevice ? { deviceId: savedVideoDevice } : {}),
      });
      this.manualCameraTrack = videoTrack;
      await this.room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.Camera,
        simulcast: quality !== "source",
        videoEncoding: {
          maxBitrate: CAMERA_PUBLISH_BITRATES[quality],
          maxFramerate: quality === "low" ? 15 : 30,
        },
      });
      this.ws.send({ type: "voice_camera", payload: { enabled: true } });
      // Re-apply audio pipeline — publishing a new track can trigger WebRTC
      // renegotiation which resets the mic sender, bypassing our GainNode mute.
      this._audioPipeline.setupAudioPipeline();
      this.reapplyMuteGain();
      log.info("Camera enabled", { quality, maxBitrate: CAMERA_PUBLISH_BITRATES[quality] });
    } catch (err) {
      setLocalCamera(false);
      log.error("Failed to enable camera", err);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        this.onErrorCallback?.("Camera permission denied");
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        this.onErrorCallback?.("No camera found");
      } else {
        this.onErrorCallback?.("Failed to start camera");
      }
    }
  }

  async disableCamera(): Promise<void> {
    try {
      this.stopManualCameraTrack();
      // Also call setCameraEnabled(false) as a fallback to clean up any
      // LiveKit-managed camera track that might exist.
      if (this.room !== null) await this.room.localParticipant.setCameraEnabled(false);
    } catch (err) {
      log.warn("Failed to disable camera track (non-fatal)", err);
    } finally {
      setLocalCamera(false);
      if (this.ws !== null) this.ws.send({ type: "voice_camera", payload: { enabled: false } });
      log.info("Camera disabled");
    }
  }

  private stopManualCameraTrack(): void {
    if (this.manualCameraTrack === null || this.room === null) return;
    const track = this.manualCameraTrack;
    this.manualCameraTrack = null;
    try {
      void this.room.localParticipant.unpublishTrack(track.mediaStreamTrack);
    } catch { /* already unpublished */ }
    track.stop();
  }

  async enableScreenshare(): Promise<void> {
    if (this.room === null || this.ws === null) {
      log.warn("Cannot enable screenshare: no active voice session");
      this.onErrorCallback?.("Join a voice channel first");
      return;
    }
    setLocalScreenshare(true);
    const quality = getStreamQuality();
    try {
      this.stopManualScreenTracks();
      const screenTracks = await createLocalScreenTracks(SCREENSHARE_PRESETS[quality]);
      this.manualScreenTracks = screenTracks;
      for (const track of screenTracks) {
        const isVideo = track.kind === Track.Kind.Video;
        await this.room.localParticipant.publishTrack(track, {
          source: isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          simulcast: false,  // No simulcast for screenshare — send full quality
          ...(isVideo ? {
            videoEncoding: {
              maxBitrate: SCREENSHARE_PUBLISH_BITRATES[quality],
              maxFramerate: quality === "low" ? 5 : quality === "medium" ? 15 : 30,
            },
          } : {}),
        });
      }
      this.ws.send({ type: "voice_screenshare", payload: { enabled: true } });
      // Re-apply audio pipeline — same renegotiation risk as camera.
      this._audioPipeline.setupAudioPipeline();
      this.reapplyMuteGain();
      log.info("Screenshare enabled", { quality, maxBitrate: SCREENSHARE_PUBLISH_BITRATES[quality] });
    } catch (err) {
      setLocalScreenshare(false);
      log.error("Failed to enable screenshare", err);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        this.onErrorCallback?.("Screen sharing permission denied");
      } else {
        this.onErrorCallback?.("Failed to start screen sharing");
      }
    }
  }

  async disableScreenshare(): Promise<void> {
    try {
      this.stopManualScreenTracks();
      if (this.room !== null) await this.room.localParticipant.setScreenShareEnabled(false);
    } catch (err) {
      log.warn("Failed to disable screenshare track (non-fatal)", err);
    } finally {
      setLocalScreenshare(false);
      if (this.ws !== null) this.ws.send({ type: "voice_screenshare", payload: { enabled: false } });
      log.info("Screenshare disabled");
    }
  }

  private stopManualScreenTracks(): void {
    if (this.manualScreenTracks.length === 0 || this.room === null) return;
    const tracks = this.manualScreenTracks;
    this.manualScreenTracks = [];
    for (const track of tracks) {
      try {
        void this.room.localParticipant.unpublishTrack(track.mediaStreamTrack);
      } catch { /* already unpublished */ }
      track.stop();
    }
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

  getUserVolume(userId: number): number { return this._audioElements.getUserVolume(userId); }

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
    if (this.room === null) return null;
    const cameraPub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (cameraPub?.track?.mediaStreamTrack) return new MediaStream([cameraPub.track.mediaStreamTrack]);
    return null;
  }

  getLocalScreenshareStream(): MediaStream | null {
    if (this.room === null) return null;
    const screenPub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) return new MediaStream([screenPub.track.mediaStreamTrack]);
    return null;
  }

  /** Get a remote participant's video MediaStream by userId and track type. Returns null if not available. */
  getRemoteVideoStream(userId: number, type: "camera" | "screenshare"): MediaStream | null {
    if (this.room === null) return null;
    const participant = this.room.getParticipantByIdentity(`user-${userId}`);
    if (participant === undefined) return null;
    // Self-guard: don't return local participant's stream via this method
    if (participant === this.room.localParticipant) return null;
    const source = type === "screenshare" ? Track.Source.ScreenShare : Track.Source.Camera;
    const pub = participant.getTrackPublication(source);
    if (pub?.track?.mediaStreamTrack) return new MediaStream([pub.track.mediaStreamTrack]);
    return null;
  }

  getRoom(): Room | null {
    return this.room;
  }

  getSessionDebugInfo(): Record<string, unknown> {
    if (this.room === null) {
      return { hasRoom: false, hasRNNoiseProcessor: false, currentChannelId: this.currentChannelId };
    }
    const remoteParticipants = [...this.room.remoteParticipants.values()].map((p) => {
      const userId = parseUserId(p.identity);
      return {
        identity: p.identity,
        userId,
        volume: p.getVolume(),
        effectiveVolume: this.getEffectiveVolume(userId),
        tracks: [...p.trackPublications.values()].map((pub) => ({
          sid: pub.trackSid, source: pub.source, kind: pub.kind,
          subscribed: pub.isSubscribed, enabled: pub.isEnabled,
        })),
      };
    });
    const localTracks = [...this.room.localParticipant.trackPublications.values()].map((pub) => ({
      sid: pub.trackSid, source: pub.source, kind: pub.kind, isMuted: pub.isMuted,
    }));
    return {
      hasRoom: true, roomName: this.room.name, roomState: this.room.state,
      hasRNNoiseProcessor: this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.getProcessor() !== undefined,
      currentChannelId: this.currentChannelId,
      outputVolumeMultiplier: this.outputVolumeMultiplier,
      audioPipelineActive: this._audioPipeline.isActive,
      audioPipelineGain: this._audioPipeline.gainValue,
      audioPipelineCtxState: this._audioPipeline.ctxState,
      vadGated: this._audioPipeline.isVadGated,
      currentInputGain: this._audioPipeline.inputGain,
      localParticipant: this.room.localParticipant.identity, localTracks,
      remoteParticipants,
      iceConnectionState: this.getIceConnectionState(),
    };
  }

  /** Log ICE connection details for debugging cross-network voice issues. */
  private logIceConnectionInfo(): void {
    if (this.room === null) return;
    // Access the underlying RTCPeerConnection via LiveKit's engine.
    // LiveKit exposes the PeerConnection via room.engine.subscriber/publisher.
    try {
      const engine = (this.room as unknown as Record<string, unknown>).engine as Record<string, unknown> | undefined;
      if (!engine) return;

      const subscriber = engine.subscriber as Record<string, unknown> | undefined;
      const publisher = engine.publisher as Record<string, unknown> | undefined;
      const pcs: Array<{ label: string; pc: RTCPeerConnection }> = [];
      if (subscriber?.pc) pcs.push({ label: "subscriber", pc: subscriber.pc as RTCPeerConnection });
      if (publisher?.pc) pcs.push({ label: "publisher", pc: publisher.pc as RTCPeerConnection });

      for (const { label, pc } of pcs) {
        log.info(`ICE ${label} connection state`, {
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          connectionState: pc.connectionState,
          signalingState: pc.signalingState,
        });

        // Log selected candidate pair
        pc.getStats().then((stats) => {
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded") {
              const localId = report.localCandidateId;
              const remoteId = report.remoteCandidateId;
              let localType = "unknown";
              let remoteType = "unknown";
              let localProtocol = "unknown";

              stats.forEach((s) => {
                if (s.id === localId && s.type === "local-candidate") {
                  localType = s.candidateType ?? "unknown";
                  localProtocol = s.protocol ?? "unknown";
                }
                if (s.id === remoteId && s.type === "remote-candidate") {
                  remoteType = s.candidateType ?? "unknown";
                }
              });

              log.info(`ICE ${label} selected candidate pair`, {
                localType,
                remoteType,
                localProtocol,
              });
            }
          });
        }).catch((err) => {
          log.debug("Failed to get ICE stats", { error: String(err) });
        });
      }
    } catch (err) {
      log.debug("Failed to access ICE connection info", { error: String(err) });
    }
  }

  /** Get ICE connection state summary for debug panel. */
  private getIceConnectionState(): Record<string, unknown> | null {
    if (this.room === null) return null;
    try {
      const engine = (this.room as unknown as Record<string, unknown>).engine as Record<string, unknown> | undefined;
      if (!engine) return null;
      const subscriber = engine.subscriber as Record<string, unknown> | undefined;
      const publisher = engine.publisher as Record<string, unknown> | undefined;
      const result: Record<string, unknown> = {};
      if (subscriber?.pc) {
        const pc = subscriber.pc as RTCPeerConnection;
        result.subscriber = {
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState,
        };
      }
      if (publisher?.pc) {
        const pc = publisher.pc as RTCPeerConnection;
        result.publisher = {
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState,
        };
      }
      return result;
    } catch {
      return null;
    }
  }
}

// --- Singleton instance + re-exported bound methods ---

const session = new LiveKitSession();

// Expose debug info on window under __owncord namespace for DevTools console access
// Usage: JSON.stringify(__owncord.lkDebug(), null, 2)
const owncordNs = ((window as unknown as Record<string, unknown>).__owncord ??= {}) as Record<string, unknown>;
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

export function getRoomForStats(): Room | null {
  return session.getRoom();
}
