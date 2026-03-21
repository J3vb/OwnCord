// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  DisconnectReason,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setSpeakers,
} from "@stores/voice.store";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import { createNoiseSuppressor } from "@lib/noise-suppression";
import type { NoiseSuppressor } from "@lib/noise-suppression";

const log = createLogger("livekitSession");

// --- Pure helpers (no instance state) ---

/** Parse userId from LiveKit participant identity "user-{id}". Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)$/);
  if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
  return 0;
}

/** Compute RMS audio level (0-1) from frequency data. */
export function computeRms(data: Uint8Array<ArrayBuffer>): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] ?? 0) / 255;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

/** Get saved per-user volume (0-200 range, default 100). */
function getSavedUserVolume(userId: number): number {
  return loadPref<number>(`userVolume_${userId}`, 100);
}

/** Compare two pre-sorted speaker ID arrays. Both must be sorted ascending. */
function speakerSetsEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// --- Types ---

type RemoteVideoCallback = (userId: number, stream: MediaStream) => void;
type RemoteVideoRemovedCallback = (userId: number) => void;

interface RemoteAnalyser {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  data: Uint8Array<ArrayBuffer>;
}

// --- LiveKitSession class ---

export class LiveKitSession {
  private room: Room | null = null;
  private ws: WsClient | null = null;
  private noiseSuppressor: NoiseSuppressor | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private currentChannelId: number | null = null;
  private serverHost: string | null = null;
  private speakingPollInterval: ReturnType<typeof setInterval> | null = null;
  private speakingThreshold = ((100 - 50) / 100) * 0.15;
  private rawMicStream: MediaStream | null = null;
  private readonly audioElements = new Map<string, HTMLAudioElement>();
  private audioContainer: HTMLDivElement | null = null;
  private onRemoteVideoCallback: RemoteVideoCallback | null = null;
  private onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  private sharedAudioCtx: AudioContext | null = null;
  private readonly remoteAnalysers = new Map<number, RemoteAnalyser>();
  private localMicGated = false;
  private localAnalyser: AnalyserNode | null = null;
  private localAnalyserSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyserClonedTrack: MediaStreamTrack | null = null;
  private readonly localAnalyserData = new Uint8Array(128);
  private previousSpeakerIds: readonly number[] = [];
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Shared AudioContext (lazy) ---

  private getSharedAudioCtx(): AudioContext {
    if (this.sharedAudioCtx === null || this.sharedAudioCtx.state === "closed") {
      this.sharedAudioCtx = new AudioContext({ sampleRate: 48000 });
    }
    return this.sharedAudioCtx;
  }

  private closeSharedAudioCtx(): void {
    if (this.sharedAudioCtx !== null) {
      void this.sharedAudioCtx.close();
      this.sharedAudioCtx = null;
    }
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
    return newRoom;
  }

  // --- Audio container ---

  private getOrCreateAudioContainer(): HTMLDivElement {
    if (this.audioContainer !== null) return this.audioContainer;
    const existing = document.getElementById("voice-audio-container");
    if (existing instanceof HTMLDivElement) {
      this.audioContainer = existing;
      return this.audioContainer;
    }
    const div = document.createElement("div");
    div.id = "voice-audio-container";
    div.style.display = "none";
    document.body.appendChild(div);
    this.audioContainer = div;
    return this.audioContainer;
  }

  private cleanupAudioElements(): void {
    for (const el of this.audioElements.values()) {
      el.srcObject = null;
      el.remove();
    }
    this.audioElements.clear();
  }

  // --- RNNoise ---

  private async publishWithNoiseSuppression(): Promise<void> {
    if (this.room === null) return;
    const savedDevice = loadPref<string>("audioInputDevice", "");
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: savedDevice ? { exact: savedDevice } : undefined,
        echoCancellation: loadPref("echoCancellation", true),
        noiseSuppression: loadPref("noiseSuppression", true),
        autoGainControl: loadPref("autoGainControl", true),
      },
      video: false,
    };
    const rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    this.rawMicStream = rawStream;
    try {
      this.noiseSuppressor = createNoiseSuppressor();
      const processedStream = await this.noiseSuppressor.process(rawStream);
      const processedTrack = processedStream.getAudioTracks()[0];
      if (processedTrack) {
        await this.room.localParticipant.publishTrack(processedTrack, {
          source: Track.Source.Microphone,
        });
      }
    } catch (err) {
      for (const track of rawStream.getTracks()) track.stop();
      this.rawMicStream = null;
      if (this.noiseSuppressor !== null) {
        this.noiseSuppressor.destroy();
        this.noiseSuppressor = null;
      }
      throw err;
    }
  }

  // --- Room event handlers (arrow fns to preserve `this`) ---

  private handleTrackSubscribed = (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    const userId = parseUserId(participant.identity);
    if (track.kind === Track.Kind.Audio) {
      const container = this.getOrCreateAudioContainer();
      const audioEl = track.attach();
      const savedVolume = userId > 0 ? getSavedUserVolume(userId) : 100;
      audioEl.volume = Math.min(savedVolume, 100) / 100;
      if (voiceStore.getState().localDeafened) audioEl.muted = true;
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on remote audio", err);
        });
      }
      container.appendChild(audioEl);
      const trackKey = `${participant.identity}-${track.sid}`;
      this.audioElements.set(trackKey, audioEl);
      if (userId > 0) this.addRemoteAnalyser(userId, track.mediaStreamTrack);
      log.debug("Remote audio track subscribed", { userId, trackSid: track.sid });
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
      track.detach().forEach((el) => el.remove());
      const trackKey = `${participant.identity}-${track.sid}`;
      this.audioElements.delete(trackKey);
      if (userId > 0) this.removeRemoteAnalyser(userId);
      log.debug("Remote audio track unsubscribed", { userId, trackSid: track.sid });
    } else if (track.kind === Track.Kind.Video) {
      track.detach();
      if (userId > 0) this.onRemoteVideoRemovedCallback?.(userId);
      log.debug("Remote video track unsubscribed", { userId, trackSid: track.sid });
    }
  };

  // --- Remote audio analysers ---

  private addRemoteAnalyser(userId: number, mediaTrack: MediaStreamTrack): void {
    this.removeRemoteAnalyser(userId);
    try {
      const ctx = this.getSharedAudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      const stream = new MediaStream([mediaTrack]);
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      this.remoteAnalysers.set(userId, { analyser, source, data: new Uint8Array(128) as Uint8Array<ArrayBuffer> });
    } catch (err) {
      log.warn("Failed to create remote analyser", { userId, error: err });
    }
  }

  private removeRemoteAnalyser(userId: number): void {
    const ra = this.remoteAnalysers.get(userId);
    if (ra) {
      ra.source.disconnect();
      ra.analyser.disconnect();
      this.remoteAnalysers.delete(userId);
    }
  }

  private cleanupAllRemoteAnalysers(): void {
    for (const [id] of this.remoteAnalysers) this.removeRemoteAnalyser(id);
  }

  // --- Local mic analyser ---

  private startLocalAnalyser(): void {
    this.stopLocalAnalyser();
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const mediaTrack = micPub?.track?.mediaStreamTrack;
    if (!mediaTrack) return;
    try {
      const ctx = this.getSharedAudioCtx();
      this.localAnalyser = ctx.createAnalyser();
      this.localAnalyser.fftSize = 256;
      this.localAnalyser.smoothingTimeConstant = 0.5;
      this.localAnalyserClonedTrack = mediaTrack.clone();
      const stream = new MediaStream([this.localAnalyserClonedTrack]);
      this.localAnalyserSource = ctx.createMediaStreamSource(stream);
      this.localAnalyserSource.connect(this.localAnalyser);
      log.debug("Local mic analyser started");
    } catch (err) {
      log.warn("Failed to start local mic analyser", err);
    }
  }

  private stopLocalAnalyser(): void {
    if (this.localAnalyserSource !== null) {
      this.localAnalyserSource.disconnect();
      this.localAnalyserSource = null;
    }
    if (this.localAnalyser !== null) {
      this.localAnalyser.disconnect();
      this.localAnalyser = null;
    }
    if (this.localAnalyserClonedTrack !== null) {
      this.localAnalyserClonedTrack.stop();
      this.localAnalyserClonedTrack = null;
    }
  }

  // --- Speaking poll ---

  private startSpeakingPoll(): void {
    this.stopSpeakingPoll();
    this.localMicGated = false;
    this.previousSpeakerIds = [];
    this.speakingPollInterval = setInterval(() => {
      if (this.room === null || this.currentChannelId === null) return;
      const speakerIds: number[] = [];
      let localLevel = 0;
      if (this.localAnalyser !== null) {
        this.localAnalyser.getByteFrequencyData(this.localAnalyserData);
        localLevel = computeRms(this.localAnalyserData);
      }
      const localSpeaking = localLevel > this.speakingThreshold;
      const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (micPub?.track?.mediaStreamTrack) {
        if (localSpeaking && this.localMicGated) {
          micPub.track.mediaStreamTrack.enabled = true;
          this.localMicGated = false;
        } else if (!localSpeaking && !this.localMicGated) {
          micPub.track.mediaStreamTrack.enabled = false;
          this.localMicGated = true;
        }
      }
      if (localSpeaking) {
        const localId = parseUserId(this.room.localParticipant.identity);
        if (localId > 0) speakerIds.push(localId);
      }
      for (const [userId, ra] of this.remoteAnalysers) {
        ra.analyser.getByteFrequencyData(ra.data);
        if (computeRms(ra.data) > this.speakingThreshold) speakerIds.push(userId);
      }
      // Sort in place so speakerSetsEqual can compare without allocations.
      speakerIds.sort((x, y) => x - y);
      if (!speakerSetsEqual(speakerIds, this.previousSpeakerIds)) {
        this.previousSpeakerIds = speakerIds; // already a fresh array each tick
        setSpeakers({ channel_id: this.currentChannelId, speakers: speakerIds });
      }
    }, 100);
  }

  private stopSpeakingPoll(): void {
    if (this.speakingPollInterval !== null) {
      clearInterval(this.speakingPollInterval);
      this.speakingPollInterval = null;
    }
    this.stopLocalAnalyser();
    this.cleanupAllRemoteAnalysers();
    this.previousSpeakerIds = [];
  }

  private handleDisconnected = (reason?: DisconnectReason): void => {
    log.info("LiveKit room disconnected", { reason });
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    this.leaveVoice(false);
    if (isUnexpected) this.onErrorCallback?.("Voice connection lost — disconnected");
  };

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
    // Re-arm as fallback in case the server doesn't respond (network hiccup,
    // restart). If the server does respond, handleVoiceTokenRefresh restarts
    // the timer, superseding this one.
    this.startTokenRefreshTimer();
  }

  /**
   * Handle a voice_token message that is a refresh (room already connected).
   * LiveKit tokens are validated at connect time only — the existing connection
   * stays alive regardless of token expiry. We just restart the refresh timer
   * so we keep requesting fresh tokens periodically.
   */
  handleVoiceTokenRefresh(): void {
    this.startTokenRefreshTimer();
    log.info("Voice token refreshed, timer restarted");
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
    // If already connected to the same channel, this is a token refresh response.
    // LiveKit validates tokens only at connect time, so just restart the timer.
    // Guard on room.state to avoid treating a mid-retry token as a refresh.
    if (this.room !== null && this.currentChannelId === channelId
        && this.room.state === "connected") {
      this.handleVoiceTokenRefresh();
      return;
    }
    if (this.room !== null) this.leaveVoice(false);
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
      this.speakingThreshold = ((100 - loadPref<number>("voiceSensitivity", 50)) / 100) * 0.15;
      this.startSpeakingPoll();
      const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
      try {
        if (enhancedNS) {
          await this.publishWithNoiseSuppression();
          log.info("Published mic with RNNoise noise suppression");
        } else {
          await this.room.localParticipant.setMicrophoneEnabled(true);
          log.info("Published mic via LiveKit native capture");
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
      this.currentChannelId = channelId;
      this.startLocalAnalyser();
      this.startTokenRefreshTimer();
      log.info("Voice session active", { channelId });
    } catch (err) {
      log.error("Failed to connect to LiveKit", err);
      if (this.room !== null) {
        this.onErrorCallback?.("Failed to join voice — connection error");
      }
      this.leaveVoice(false);
    }
  }

  leaveVoice(sendWs = true): void {
    this.clearTokenRefreshTimer();
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    if (this.rawMicStream !== null) {
      for (const track of this.rawMicStream.getTracks()) track.stop();
      this.rawMicStream = null;
    }
    if (this.noiseSuppressor !== null) {
      this.noiseSuppressor.destroy();
      this.noiseSuppressor = null;
    }
    this.stopSpeakingPoll();
    if (this.room !== null) {
      const r = this.room;
      this.room = null;
      r.removeAllListeners();
      r.disconnect().catch((err) => log.warn("room.disconnect() error (non-fatal)", err));
    }
    this.cleanupAudioElements();
    this.closeSharedAudioCtx();
    this.currentChannelId = null;
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
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        for (const pub of participant.audioTrackPublications.values()) pub.setSubscribed(!deafened);
      }
    }
    for (const el of this.audioElements.values()) el.muted = deafened;
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

  async switchInputDevice(deviceId: string): Promise<void> {
    if (this.room === null) {
      log.debug("Skipping input device switch — no active voice session");
      return;
    }
    try {
      const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
      if (enhancedNS && this.noiseSuppressor !== null) {
        if (this.rawMicStream !== null) {
          for (const track of this.rawMicStream.getTracks()) track.stop();
          this.rawMicStream = null;
        }
        this.noiseSuppressor.destroy();
        this.noiseSuppressor = null;
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          if (pub.source === Track.Source.Microphone && pub.track) {
            await this.room.localParticipant.unpublishTrack(pub.track);
          }
        }
        await this.publishWithNoiseSuppression();
      } else {
        if (deviceId) {
          await this.room.switchActiveDevice("audioinput", deviceId);
        } else {
          await this.room.localParticipant.setMicrophoneEnabled(false);
          await this.room.localParticipant.setMicrophoneEnabled(true);
        }
      }
      log.info("Switched input device", { deviceId });
    } catch (err) {
      log.error("Failed to switch input device", err);
      this.onErrorCallback?.("Failed to switch microphone");
    }
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    if (this.room !== null) await this.room.switchActiveDevice("audiooutput", deviceId);
    for (const el of this.audioElements.values()) {
      if (typeof el.setSinkId === "function") {
        try { await el.setSinkId(deviceId); } catch (err) {
          log.warn("Failed to set output device on audio element", err);
        }
      }
    }
    log.info("Switched output device", { deviceId });
  }

  setUserVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref(`userVolume_${userId}`, clamped);
    if (this.room !== null) {
      for (const participant of this.room.remoteParticipants.values()) {
        if (parseUserId(participant.identity) === userId) {
          for (const pub of participant.audioTrackPublications.values()) {
            if (pub.track) {
              for (const el of pub.track.attachedElements) {
                if (el instanceof HTMLAudioElement) el.volume = Math.min(clamped, 100) / 100;
              }
            }
          }
        }
      }
    }
  }

  getUserVolume(userId: number): number { return getSavedUserVolume(userId); }

  setVoiceSensitivity(sensitivity: number): void {
    const clamped = Math.max(0, Math.min(100, sensitivity));
    this.speakingThreshold = ((100 - clamped) / 100) * 0.15;
  }

  getLocalCameraStream(): MediaStream | null {
    if (this.room === null) return null;
    const cameraPub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (cameraPub?.track?.mediaStreamTrack) return new MediaStream([cameraPub.track.mediaStreamTrack]);
    return null;
  }

  getSessionDebugInfo(): Record<string, unknown> {
    if (this.room === null) {
      return { hasRoom: false, hasNoiseSuppressor: this.noiseSuppressor !== null, currentChannelId: this.currentChannelId };
    }
    const remoteParticipants = [...this.room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      userId: parseUserId(p.identity),
      tracks: [...p.trackPublications.values()].map((pub) => ({
        sid: pub.trackSid, source: pub.source, kind: pub.kind,
        subscribed: pub.isSubscribed, enabled: pub.isEnabled,
      })),
    }));
    const localTracks = [...this.room.localParticipant.trackPublications.values()].map((pub) => ({
      sid: pub.trackSid, source: pub.source, kind: pub.kind, isMuted: pub.isMuted,
    }));
    return {
      hasRoom: true, roomName: this.room.name, roomState: this.room.state,
      hasNoiseSuppressor: this.noiseSuppressor !== null, currentChannelId: this.currentChannelId,
      localParticipant: this.room.localParticipant.identity, localTracks,
      remoteParticipants, audioElements: this.audioElements.size,
    };
  }
}

// --- Singleton instance + re-exported bound methods ---

const session = new LiveKitSession();

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
export const switchInputDevice = session.switchInputDevice.bind(session);
export const switchOutputDevice = session.switchOutputDevice.bind(session);
export const setUserVolume = session.setUserVolume.bind(session);
export const getUserVolume = session.getUserVolume.bind(session);
export const setVoiceSensitivity = session.setVoiceSensitivity.bind(session);
export const getLocalCameraStream = session.getLocalCameraStream.bind(session);
export const getSessionDebugInfo = session.getSessionDebugInfo.bind(session);
