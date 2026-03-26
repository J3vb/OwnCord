// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
  type LocalAudioTrack,
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
} from "@stores/voice.store";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { createRNNoiseProcessor } from "@lib/noise-suppression";

const log = createLogger("livekitSession");

// --- Pure helpers (no instance state) ---

/** Parse userId from LiveKit participant identity "user-{id}". Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)$/);
  if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
  return 0;
}

/** Get saved per-user volume (0-200 range, default 100). Applied via LiveKit's GainNode-backed setVolume(). */
function getSavedUserVolume(userId: number): number {
  return loadPref<number>(`userVolume_${userId}`, 100);
}

// --- Types ---

type RemoteVideoCallback = (userId: number, stream: MediaStream) => void;
type RemoteVideoRemovedCallback = (userId: number) => void;

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
  /** Last known LiveKit URL and directUrl for auto-reconnect on unexpected disconnect. */
  private lastUrl: string | null = null;
  private lastDirectUrl: string | undefined = undefined;
  /** Max auto-reconnect attempts before giving up and showing error. */
  private static readonly MAX_RECONNECT_ATTEMPTS = 2;
  private static readonly RECONNECT_DELAY_MS = 3000;
  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier = loadPref<number>("outputVolume", 100) / 100;

  // --- Unified audio pipeline: input volume + VAD gating ---
  // Pipeline: rawMicTrack → source → analyser (VAD reads here)
  //                                 → gainNode (volume × vadGate) → dest → WebRTC sender
  private audioPipelineCtx: AudioContext | null = null;
  private audioPipelineGain: GainNode | null = null;
  private audioPipelineAnalyser: AnalyserNode | null = null;
  private audioPipelineDest: MediaStreamAudioDestinationNode | null = null;
  private vadAnimFrame: number = 0;
  /** When true, mic is currently gated (muted by VAD — gain set to 0). */
  private vadGated = false;
  /** The user's input volume gain (0-2.0). VAD multiplies this by 0 or 1. */
  private currentInputGain = 1.0;

  // --- RNNoise processor (LiveKit TrackProcessor API) ---

  /** Attach RNNoise processor to the local mic track. Safe to call if already attached. */
  private async applyNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.getProcessor() !== undefined) return;
    const processor = createRNNoiseProcessor();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LocalTrack.setProcessor uses wide generic, but AudioProcessorOptions is guaranteed at runtime with webAudioMix
    await micPub.track.setProcessor(processor as any);
    log.info("RNNoise processor attached to mic track");
  }

  /** Remove RNNoise processor from the local mic track. Safe to call if none attached. */
  private async removeNoiseSuppressor(): Promise<void> {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    if (micPub.track.getProcessor() === undefined) return;
    await micPub.track.stopProcessor();
    log.info("RNNoise processor removed from mic track");
  }

  // --- Room factory ---

  private createRoom(): Room {
    const newRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: loadPref("echoCancellation", true),
        noiseSuppression: loadPref("noiseSuppression", true),
        autoGainControl: loadPref("autoGainControl", true),
      },
    });
    newRoom.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    newRoom.on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed);
    newRoom.on(RoomEvent.Disconnected, this.handleDisconnected);
    newRoom.on(RoomEvent.ActiveSpeakersChanged, this.handleActiveSpeakersChanged);
    newRoom.on(RoomEvent.AudioPlaybackStatusChanged, this.handleAudioPlaybackChanged);
    return newRoom;
  }

  // --- Room event handlers (arrow fns to preserve `this`) ---

  private handleTrackSubscribed = (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      // Detach any previous <audio> elements to prevent duplicate playback
      // on fast reconnects (new subscription fires before old unsubscription)
      for (const el of track.detach()) el.remove();
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      // Apply saved per-user volume via LiveKit's setVolume (supports 0-2.0 range)
      participant.setVolume(this.getEffectiveVolume(userId));
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on remote audio", err);
        });
      }
      log.debug("Remote audio track subscribed and attached", { userId, trackSid: track.sid });
    } else if (track.kind === Track.Kind.Video) {
      if (userId > 0 && this.onRemoteVideoCallback !== null) {
        const stream = new MediaStream([track.mediaStreamTrack]);
        this.onRemoteVideoCallback(userId, stream);
      }
      log.debug("Remote video track subscribed", { userId, trackSid: track.sid });
    }
  };

  private handleTrackUnsubscribed = (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      for (const el of track.detach()) el.remove();
      log.debug("Remote audio track unsubscribed and detached", { userId, trackSid: track.sid });
    } else if (track.kind === Track.Kind.Video) {
      track.detach();
      if (userId > 0) this.onRemoteVideoRemovedCallback?.(userId);
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
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    if (isUnexpected && this.latestToken !== null && this.currentChannelId !== null && this.lastUrl !== null) {
      // Attempt auto-reconnect with stored token before giving up.
      const token = this.latestToken;
      const url = this.lastUrl;
      const channelId = this.currentChannelId;
      const directUrl = this.lastDirectUrl;
      // Clean up current room without sending WS leave (we're reconnecting, not leaving).
      this.teardownAudioPipeline();
      this.removeAutoplayUnlock();
      this.clearTokenRefreshTimer();
      if (this.room !== null) {
        const r = this.room;
        this.room = null;
        r.removeAllListeners();
        r.disconnect().catch(() => {});
      }
      void this.attemptAutoReconnect(token, url, channelId, directUrl);
      return;
    }
    this.leaveVoice(false);
    leaveVoiceChannel();
    if (isUnexpected) this.onErrorCallback?.("Voice connection lost — disconnected");
  };

  /** Attempt to auto-reconnect after unexpected disconnect using stored token. */
  private async attemptAutoReconnect(
    token: string, url: string, channelId: number, directUrl?: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= LiveKitSession.MAX_RECONNECT_ATTEMPTS; attempt++) {
      log.info("Auto-reconnect attempt", { attempt, maxAttempts: LiveKitSession.MAX_RECONNECT_ATTEMPTS });
      await new Promise((r) => setTimeout(r, LiveKitSession.RECONNECT_DELAY_MS));
      // If user manually left or joined a different channel during the delay, abort.
      if (this.currentChannelId !== channelId) {
        log.info("Auto-reconnect aborted — channel changed");
        return;
      }
      try {
        this.room = this.createRoom();
        const resolvedUrl = this.resolveLiveKitUrl(url, directUrl);
        await this.room.connect(resolvedUrl, token);
        log.info("Auto-reconnect succeeded", { attempt, channelId });
        this.room.startAudio().catch(() => {});
        try {
          await this.room.localParticipant.setMicrophoneEnabled(true);
          if (loadPref<boolean>("enhancedNoiseSuppression", false)) {
            await this.applyNoiseSuppressor();
          }
        } catch (micErr) {
          log.warn("Auto-reconnect: mic unavailable — listen-only mode", micErr);
        }
        this.setupAudioPipeline();
        this.startTokenRefreshTimer();
        // Request a fresh token since the stored one may be close to expiry.
        this.requestTokenRefresh();
        return;
      } catch (err) {
        log.warn("Auto-reconnect failed", { attempt, error: err });
        if (this.room !== null) {
          this.room.removeAllListeners();
          this.room.disconnect().catch(() => {});
          this.room = null;
        }
      }
    }
    // All attempts exhausted — give up and clean up.
    log.error("Auto-reconnect exhausted all attempts, giving up");
    this.leaveVoice(false);
    leaveVoiceChannel();
    this.onErrorCallback?.("Voice connection lost — failed to reconnect");
  }

  // --- URL resolution ---

  private resolveLiveKitUrl(proxyPath: string, directUrl?: string): string {
    if (this.serverHost !== null) {
      const host = this.serverHost.split(":")[0] ?? "";
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (isLocal && directUrl) return directUrl;
      if (proxyPath.startsWith("/")) return `wss://${this.serverHost}${proxyPath}`;
    }
    return proxyPath;
  }

  // --- Token refresh ---

  /** Token refresh interval: 3.5 hours (refresh 30min before 4h TTL expiry). */
  private static readonly TOKEN_REFRESH_MS = 3.5 * 60 * 60 * 1000;

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
    this.startTokenRefreshTimer();
  }

  handleVoiceTokenRefresh(token?: string): void {
    // The installed livekit-client SDK version does not expose a refreshToken
    // method on Room. Store the fresh token so that if LiveKit disconnects
    // (e.g. token expiry), the reconnection path in handleVoiceToken can use
    // it automatically. For now, the 4h TTL with 3.5h refresh request ensures
    // a fresh token is always available before expiry.
    if (token) {
      this.latestToken = token;
    }
    this.startTokenRefreshTimer();
    log.info("Voice token refreshed, timer restarted");
  }

  // --- Volume helpers ---

  /** Compute the effective volume for a participant: per-user volume * master output. */
  private getEffectiveVolume(userId: number): number {
    const userVol = userId > 0 ? getSavedUserVolume(userId) : 100;
    return (userVol / 100) * this.outputVolumeMultiplier;
  }

  /** Apply effective volume to all remote participants. */
  private applyAllVolumes(): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      const userId = parseUserId(participant.identity);
      participant.setVolume(this.getEffectiveVolume(userId));
    }
  }

  // --- Public API ---

  setWsClient(client: WsClient): void { this.ws = client; }
  setServerHost(host: string): void { this.serverHost = host; }
  setOnError(cb: (message: string) => void): void { this.onErrorCallback = cb; }
  clearOnError(): void { this.onErrorCallback = null; }
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
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Store URL/token for auto-reconnect on unexpected disconnect.
    this.latestToken = token;
    this.lastUrl = url;
    this.lastDirectUrl = directUrl;
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this.connecting) {
      log.warn("handleVoiceToken: already connecting, ignoring duplicate call");
      return;
    }
    if (this.room !== null) this.leaveVoice(false);
    this.connecting = true;
    try {
      this.room = this.createRoom();
      const resolvedUrl = this.resolveLiveKitUrl(url, directUrl);
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 2000;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.room.connect(resolvedUrl, token);
          break;
        } catch (connectErr) {
          if (attempt < MAX_RETRIES) {
            log.warn("LiveKit connect failed, retrying", { attempt, maxRetries: MAX_RETRIES, error: connectErr });
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            if (this.room === null) throw connectErr;
            this.room.removeAllListeners();
            this.room = this.createRoom();
          } else {
            throw connectErr;
          }
        }
      }
      log.info("Connected to LiveKit room", { channelId, url: resolvedUrl });
      // Optimistic startAudio — may succeed if the join was triggered by a
      // recent user gesture. If not, the AudioPlaybackStatusChanged handler
      // will register a click-to-unlock fallback.
      this.room.startAudio().catch(() => {
        log.debug("Optimistic startAudio failed — waiting for user gesture");
      });
      try {
        await this.room.localParticipant.setMicrophoneEnabled(true);
        log.info("Published mic via LiveKit native capture");
        if (loadPref<boolean>("enhancedNoiseSuppression", false)) {
          await this.applyNoiseSuppressor();
        }
      } catch (micErr) {
        if (micErr instanceof DOMException && micErr.name === "NotAllowedError") {
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
      const savedInput = loadPref<string>("audioInputDevice", "");
      if (savedInput) await this.room.switchActiveDevice("audioinput", savedInput);
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput) await this.room.switchActiveDevice("audiooutput", savedOutput);
      // Set up unified audio pipeline (input volume + VAD gating via GainNode).
      // VAD polling only starts if saved sensitivity < 100.
      this.setupAudioPipeline();
      this.currentChannelId = channelId;
      this.startTokenRefreshTimer();
      log.info("Voice session active", { channelId });
    } catch (err) {
      log.error("Failed to connect to LiveKit", err);
      if (this.room !== null) {
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      this.leaveVoice(false);
    } finally {
      this.connecting = false;
    }
  }

  leaveVoice(sendWs = true): void {
    this.clearTokenRefreshTimer();
    this.teardownAudioPipeline();
    this.removeAutoplayUnlock();
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    if (this.room !== null) {
      const r = this.room;
      this.room = null;
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
  }

  setMuted(muted: boolean): void {
    setLocalMuted(muted);
    if (this.room !== null) void this.room.localParticipant.setMicrophoneEnabled(!muted);
  }

  setDeafened(deafened: boolean): void {
    setLocalDeafened(deafened);
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of participant.audioTrackPublications.values()) pub.setSubscribed(!deafened);
    }
    log.debug("Deafen state changed", { deafened });
  }

  async enableCamera(): Promise<void> {
    if (this.room === null || this.ws === null) {
      log.warn("Cannot enable camera: no active voice session");
      this.onErrorCallback?.("Join a voice channel first");
      return;
    }
    setLocalCamera(true);
    try {
      await this.room.localParticipant.setCameraEnabled(true);
      const savedVideoDevice = loadPref<string>("videoInputDevice", "");
      if (savedVideoDevice) await this.room.switchActiveDevice("videoinput", savedVideoDevice);
      this.ws.send({ type: "voice_camera", payload: { enabled: true } });
      log.info("Camera enabled");
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
      if (this.room !== null) await this.room.localParticipant.setCameraEnabled(false);
    } catch (err) {
      log.warn("Failed to disable camera track (non-fatal)", err);
    } finally {
      setLocalCamera(false);
      if (this.ws !== null) this.ws.send({ type: "voice_camera", payload: { enabled: false } });
      log.info("Camera disabled");
    }
  }

  async enableScreenshare(): Promise<void> {
    if (this.room === null || this.ws === null) {
      log.warn("Cannot enable screenshare: no active voice session");
      this.onErrorCallback?.("Join a voice channel first");
      return;
    }
    setLocalScreenshare(true);
    try {
      await this.room.localParticipant.setScreenShareEnabled(true);
      this.ws.send({ type: "voice_screenshare", payload: { enabled: true } });
      log.info("Screenshare enabled");
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
      if (this.room !== null) await this.room.localParticipant.setScreenShareEnabled(false);
    } catch (err) {
      log.warn("Failed to disable screenshare track (non-fatal)", err);
    } finally {
      setLocalScreenshare(false);
      if (this.ws !== null) this.ws.send({ type: "voice_screenshare", payload: { enabled: false } });
      log.info("Screenshare disabled");
    }
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    if (this.room === null) {
      log.debug("Skipping input device switch — no active voice session");
      return;
    }
    try {
      if (deviceId) {
        await this.room.switchActiveDevice("audioinput", deviceId);
      } else {
        await this.room.localParticipant.setMicrophoneEnabled(false);
        await this.room.localParticipant.setMicrophoneEnabled(true);
      }
      // Rebuild audio pipeline (source track changed after device switch)
      this.setupAudioPipeline();
      // Re-apply or remove RNNoise processor based on current setting
      const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
      if (enhancedNS) {
        await this.applyNoiseSuppressor();
      } else {
        await this.removeNoiseSuppressor();
      }
      log.info("Switched input device", { deviceId });
    } catch (err) {
      log.error("Failed to switch input device", err);
      this.onErrorCallback?.("Failed to switch microphone");
    }
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    if (this.room !== null) await this.room.switchActiveDevice("audiooutput", deviceId);
    log.info("Switched output device", { deviceId });
  }

  setUserVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref(`userVolume_${userId}`, clamped);
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        if (parseUserId(participant.identity) === userId) {
          participant.setVolume((clamped / 100) * this.outputVolumeMultiplier);
        }
      }
    }
  }

  getUserVolume(userId: number): number { return getSavedUserVolume(userId); }

  // ── Unified audio pipeline: input volume + VAD gating ─────────────
  //
  // Architecture:
  //   rawMicTrack → AudioContext source
  //       ├──→ AnalyserNode (VAD reads raw audio here — always sees real signal)
  //       └──→ GainNode (inputVolume × vadGate) → MediaStreamDestination → WebRTC sender
  //
  // The pipeline is always active while in a voice session. This avoids
  // creating/destroying it when volume changes, and gives the VAD a stable
  // analyser that's independent of LiveKit's track lifecycle.

  /** Build or rebuild the audio pipeline on the current mic track. */
  private setupAudioPipeline(): void {
    this.teardownAudioPipeline();
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;

    try {
      const mediaTrack = micPub.track.mediaStreamTrack;
      const ctx = new AudioContext({ sampleRate: 48000 });
      void ctx.resume(); // Ensure not suspended (WebView2 autoplay policy)

      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));

      // Analyser: VAD reads time-domain data from here (always real audio)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;

      // GainNode: controls both input volume and VAD gating
      const gainNode = ctx.createGain();
      this.currentInputGain = loadPref<number>("inputVolume", 100) / 100;
      gainNode.gain.setValueAtTime(this.currentInputGain, ctx.currentTime);

      const dest = ctx.createMediaStreamDestination();

      // Wire: source → analyser (tap) and source → gain → dest
      source.connect(analyser);
      source.connect(gainNode);
      gainNode.connect(dest);

      this.audioPipelineCtx = ctx;
      this.audioPipelineGain = gainNode;
      this.audioPipelineAnalyser = analyser;
      this.audioPipelineDest = dest;

      // Replace the WebRTC sender's track with the pipeline output
      const adjustedTrack = dest.stream.getAudioTracks()[0];
      if (adjustedTrack !== undefined && micPub.track.sender) {
        void micPub.track.sender.replaceTrack(adjustedTrack).catch((err) => {
          log.warn("Failed to replace sender track with pipeline output", err);
        });
      }

      log.info("Audio pipeline created", { inputGain: this.currentInputGain });

      // Start VAD polling if sensitivity < 100
      this.startVadPolling();
    } catch (err) {
      log.warn("Failed to set up audio pipeline", err);
    }
  }

  /** Tear down the audio pipeline and restore the original sender track. */
  private teardownAudioPipeline(): void {
    this.stopVadPolling();

    // Restore original mic track on the WebRTC sender
    if (this.room !== null) {
      const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (micPub?.track?.sender !== undefined) {
        const originalTrack = micPub.track.mediaStreamTrack;
        void micPub.track.sender.replaceTrack(originalTrack).catch(() => {});
      }
    }

    if (this.audioPipelineGain !== null) { this.audioPipelineGain.disconnect(); this.audioPipelineGain = null; }
    if (this.audioPipelineAnalyser !== null) { this.audioPipelineAnalyser.disconnect(); this.audioPipelineAnalyser = null; }
    if (this.audioPipelineDest !== null) { this.audioPipelineDest.disconnect(); this.audioPipelineDest = null; }
    if (this.audioPipelineCtx !== null) { void this.audioPipelineCtx.close(); this.audioPipelineCtx = null; }
    this.vadGated = false;
  }

  /** Update the effective gain on the pipeline (inputVolume × vadGate). */
  private updatePipelineGain(): void {
    if (this.audioPipelineGain === null || this.audioPipelineCtx === null) return;
    const effectiveGain = this.vadGated ? 0 : this.currentInputGain;
    this.audioPipelineGain.gain.setTargetAtTime(effectiveGain, this.audioPipelineCtx.currentTime, 0.015);
  }

  setInputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("inputVolume", clamped);
    this.currentInputGain = clamped / 100;
    this.updatePipelineGain();
  }

  setOutputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("outputVolume", clamped);
    this.outputVolumeMultiplier = clamped / 100;
    this.applyAllVolumes();
  }

  /**
   * Apply voice sensitivity as a client-side VAD gate.
   * Sensitivity 0 = gate everything (threshold impossibly high).
   * Sensitivity 100 = gate nothing (no VAD polling).
   * VAD sets gain to 0 when gated, restores inputVolume when ungated.
   */
  setVoiceSensitivity(sensitivity: number): void {
    const clamped = Math.max(0, Math.min(100, sensitivity));
    savePref("voiceSensitivity", clamped);
    // Restart VAD polling with the new threshold (pipeline stays intact)
    this.stopVadPolling();
    if (clamped >= 100) {
      // Ensure ungated
      if (this.vadGated) { this.vadGated = false; this.updatePipelineGain(); }
    } else {
      this.startVadPolling();
    }
    log.debug("Voice sensitivity updated", { sensitivity: clamped });
  }

  /** Start VAD polling loop — reads from the pipeline's analyser. */
  private startVadPolling(): void {
    this.stopVadPolling();
    if (this.audioPipelineAnalyser === null) return;

    const sensitivity = loadPref<number>("voiceSensitivity", 50);
    if (sensitivity >= 100) return;

    // Convert sensitivity to an RMS threshold (time-domain):
    // sensitivity 0 → threshold ~0.10, sensitivity 50 → ~0.05, sensitivity 99 → ~0.001
    const threshold = ((100 - sensitivity) / 100) * 0.10;
    const analyser = this.audioPipelineAnalyser;
    const dataArray = new Float32Array(analyser.fftSize);

    let silentFrames = 0;
    let speechFrames = 0;
    const GATE_ON_FRAMES = 12;  // ~200ms of silence before gating
    const GATE_OFF_FRAMES = 2;  // ~33ms of speech before ungating
    // Grace period: don't gate for the first ~500ms to let audio settle
    let startupFrames = 0;
    const STARTUP_GRACE = 30;

    const poll = (): void => {
      if (this.audioPipelineAnalyser === null) return;

      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      if (startupFrames < STARTUP_GRACE) {
        startupFrames++;
        this.vadAnimFrame = requestAnimationFrame(poll);
        return;
      }

      if (rms < threshold) {
        speechFrames = 0;
        silentFrames++;
        if (!this.vadGated && silentFrames >= GATE_ON_FRAMES) {
          this.vadGated = true;
          this.updatePipelineGain(); // gain → 0
        }
      } else {
        silentFrames = 0;
        speechFrames++;
        if (this.vadGated && speechFrames >= GATE_OFF_FRAMES) {
          this.vadGated = false;
          this.updatePipelineGain(); // gain → inputVolume
        }
      }

      this.vadAnimFrame = requestAnimationFrame(poll);
    };
    this.vadAnimFrame = requestAnimationFrame(poll);
    log.info("VAD polling started", { sensitivity, threshold });
  }

  /** Stop VAD polling loop (pipeline stays intact). */
  private stopVadPolling(): void {
    if (this.vadAnimFrame !== 0) {
      cancelAnimationFrame(this.vadAnimFrame);
      this.vadAnimFrame = 0;
    }
    // Ungate if was gated
    if (this.vadGated) {
      this.vadGated = false;
      this.updatePipelineGain();
    }
  }

  /**
   * Re-apply audio processing settings (echo cancellation, noise suppression, AGC)
   * to the live mic track by restarting it with updated constraints.
   */
  async reapplyAudioProcessing(): Promise<void> {
    if (this.room === null) {
      log.debug("Skipping audio processing reapply — no active voice session");
      return;
    }
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) {
      log.debug("Skipping audio processing reapply — no mic track");
      return;
    }

    const captureOptions = {
      echoCancellation: loadPref("echoCancellation", true),
      noiseSuppression: loadPref("noiseSuppression", true),
      autoGainControl: loadPref("autoGainControl", true),
    };

    try {
      // restartTrack re-acquires the mic with new constraints without unpublishing
      await (micPub.track as LocalAudioTrack).restartTrack(captureOptions);
      log.info("Audio processing reapplied via restartTrack", captureOptions);

      // Rebuild audio pipeline (underlying track changed)
      this.setupAudioPipeline();

      // Re-apply or remove RNNoise processor
      const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
      if (enhancedNS) {
        await this.applyNoiseSuppressor();
      } else {
        await this.removeNoiseSuppressor();
      }
    } catch (err) {
      log.error("Failed to reapply audio processing", err);
      this.onErrorCallback?.("Failed to update audio settings");
    }
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
      audioPipelineActive: this.audioPipelineGain !== null,
      audioPipelineGain: this.audioPipelineGain?.gain.value ?? null,
      audioPipelineCtxState: this.audioPipelineCtx?.state ?? null,
      vadGated: this.vadGated,
      currentInputGain: this.currentInputGain,
      localParticipant: this.room.localParticipant.identity, localTracks,
      remoteParticipants,
    };
  }
}

// --- Singleton instance + re-exported bound methods ---

const session = new LiveKitSession();

// Expose debug info on window for DevTools console access
// Usage: JSON.stringify(__lkDebug(), null, 2)
(window as unknown as Record<string, unknown>).__lkDebug = session.getSessionDebugInfo.bind(session);

export const setWsClient = session.setWsClient.bind(session);
export const setServerHost = session.setServerHost.bind(session);
export const setOnError = session.setOnError.bind(session);
export const clearOnError = session.clearOnError.bind(session);
export const setOnRemoteVideo = session.setOnRemoteVideo.bind(session);
export const setOnRemoteVideoRemoved = session.setOnRemoteVideoRemoved.bind(session);
export const clearOnRemoteVideo = session.clearOnRemoteVideo.bind(session);
export const handleVoiceToken = session.handleVoiceToken.bind(session);
export const leaveVoice = session.leaveVoice.bind(session);
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
export const getSessionDebugInfo = session.getSessionDebugInfo.bind(session);
