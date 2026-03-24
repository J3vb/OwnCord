// LiveKit Session — lifecycle orchestrator for voice chat via LiveKit
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
  DisconnectReason,
} from "livekit-client";
import type { WsClient } from "@lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
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
  /** Master output volume multiplier (0-2.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier = loadPref<number>("outputVolume", 100) / 100;

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

  private handleDisconnected = (reason?: DisconnectReason): void => {
    log.info("LiveKit room disconnected", { reason });
    const isUnexpected = reason !== DisconnectReason.CLIENT_INITIATED;
    this.leaveVoice(false);
    // Clear the voice store so the UI reflects the disconnected state.
    leaveVoiceChannel();
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
      // Apply saved input volume
      this.applyInputVolume(loadPref<number>("inputVolume", 100));
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
    if (sendWs && this.ws !== null) {
      this.ws.send({ type: "voice_leave", payload: {} });
    }
    this.cleanupInputGain();
    if (this.room !== null) {
      const r = this.room;
      this.room = null;
      r.removeAllListeners();
      r.disconnect().catch((err) => log.warn("room.disconnect() error (non-fatal)", err));
    }
    this.currentChannelId = null;
    this.latestToken = null;
    setLocalCamera(false);
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
      // Reset and re-apply input volume after device switch (source track changed)
      this.cleanupInputGain();
      this.applyInputVolume(loadPref<number>("inputVolume", 100));
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

  /** Input volume GainNode — adjusts mic gain via the WebRTC sender. */
  private inputGainNode: GainNode | null = null;
  private inputGainCtx: AudioContext | null = null;
  private inputGainDest: MediaStreamAudioDestinationNode | null = null;

  /** Apply input volume gain to the local mic track via a Web Audio GainNode. */
  private applyInputVolume(volume: number): void {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    const gain = Math.max(0, Math.min(200, volume)) / 100;

    // At 100% (gain=1.0), tear down the pipeline — no processing needed
    if (gain === 1 && this.inputGainNode !== null) {
      this.restoreOriginalSenderTrack();
      this.cleanupInputGain();
      log.info("Input volume reset to 100% — gain pipeline removed");
      return;
    }

    // No gain node and volume is default — nothing to do
    if (gain === 1) return;

    if (this.inputGainNode !== null) {
      this.inputGainNode.gain.setTargetAtTime(gain, 0, 0.05);
      log.debug("Input volume adjusted", { gain });
      return;
    }

    // Build GainNode pipeline and replace the sender's track
    try {
      const mediaTrack = micPub.track.mediaStreamTrack;
      const ctx = new AudioContext({ sampleRate: 48000 });
      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));
      const gainNode = ctx.createGain();
      gainNode.gain.setTargetAtTime(gain, 0, 0.05);
      const dest = ctx.createMediaStreamDestination();
      source.connect(gainNode);
      gainNode.connect(dest);

      this.inputGainNode = gainNode;
      this.inputGainCtx = ctx;
      this.inputGainDest = dest;

      // Replace the WebRTC sender's track with the gain-adjusted one
      const adjustedTrack = dest.stream.getAudioTracks()[0];
      if (adjustedTrack !== undefined && micPub.track.sender) {
        void micPub.track.sender.replaceTrack(adjustedTrack).catch((err) => {
          log.warn("Failed to replace sender track with gain-adjusted track", err);
        });
      }
      log.info("Input volume GainNode created", { gain });
    } catch (err) {
      log.warn("Failed to set up input volume gain", err);
    }
  }

  /** Restore the original mic track on the WebRTC sender (undo gain pipeline). */
  private restoreOriginalSenderTrack(): void {
    if (this.room === null) return;
    const micPub = this.room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub?.track === undefined) return;
    const originalTrack = micPub.track.mediaStreamTrack;
    if (micPub.track.sender) {
      void micPub.track.sender.replaceTrack(originalTrack).catch((err) => {
        log.warn("Failed to restore original sender track", err);
      });
    }
  }

  private cleanupInputGain(): void {
    if (this.inputGainNode !== null) {
      this.inputGainNode.disconnect();
      this.inputGainNode = null;
    }
    if (this.inputGainDest !== null) {
      this.inputGainDest.disconnect();
      this.inputGainDest = null;
    }
    if (this.inputGainCtx !== null) {
      void this.inputGainCtx.close();
      this.inputGainCtx = null;
    }
  }

  setInputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("inputVolume", clamped);
    this.applyInputVolume(clamped);
  }

  setOutputVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(200, volume));
    savePref("outputVolume", clamped);
    this.outputVolumeMultiplier = clamped / 100;
    // Re-apply all per-user volumes scaled by the new master output
    this.applyAllVolumes();
  }

  setVoiceSensitivity(_sensitivity: number): void {
    // Voice sensitivity is now handled by LiveKit's built-in speaking detection.
    // The sensitivity parameter is saved in preferences by the UI but
    // LiveKit's server-side VAD determines speaking state.
    log.debug("Voice sensitivity setting saved (handled by LiveKit VAD)");
  }

  getLocalCameraStream(): MediaStream | null {
    if (this.room === null) return null;
    const cameraPub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (cameraPub?.track?.mediaStreamTrack) return new MediaStream([cameraPub.track.mediaStreamTrack]);
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
      inputGainActive: this.inputGainNode !== null,
      inputGainValue: this.inputGainNode?.gain.value ?? null,
      inputGainCtxState: this.inputGainCtx?.state ?? null,
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
export const switchInputDevice = session.switchInputDevice.bind(session);
export const switchOutputDevice = session.switchOutputDevice.bind(session);
export const setUserVolume = session.setUserVolume.bind(session);
export const getUserVolume = session.getUserVolume.bind(session);
export const setInputVolume = session.setInputVolume.bind(session);
export const setOutputVolume = session.setOutputVolume.bind(session);
export const setVoiceSensitivity = session.setVoiceSensitivity.bind(session);
export const getLocalCameraStream = session.getLocalCameraStream.bind(session);
export const getSessionDebugInfo = session.getSessionDebugInfo.bind(session);
