// Voice media and device control — extracted from livekitSession.ts.
// Owns the mute/deafen policy, microphone (re)publishing and its SFU-grant
// wait, and the camera/screenshare, device, volume and audio-pipeline
// facades. The track implementations stay in screenShare.ts, deviceManager.ts,
// audioElements.ts and audioPipeline.ts; the session state and every
// collaborator stay owned by LiveKitSession, reached through MediaControlHost.
import { type Room, Track } from "livekit-client";
import type { WsClient } from "../../lib/ws";
import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  setListenOnly,
} from "../../stores/voice.store";
import { loadPref } from "../../components/settings/helpers";
import { createLogger } from "../../lib/logger";
import type { AudioPipeline } from "../../lib/audioPipeline";
import type { AudioElements } from "../../lib/audioElements";
import { type DeviceManager, isMicPolicyGated } from "../../lib/deviceManager";
import {
  type VideoTrackDeps,
  type CameraTrackState,
  type ScreenTrackState,
  enableCamera as doEnableCamera,
  disableCamera as doDisableCamera,
  enableScreenshare as doEnableScreenshare,
  disableScreenshare as doDisableScreenshare,
} from "../../lib/screenShare";

// Same logger tag as before the extraction, so the media log lines are unchanged.
const log = createLogger("livekitSession");

/** Everything media control needs from LiveKitSession. Collaborators are read
 *  through getters on every use, never captured, so the session stays the
 *  single owner of each one. */
export interface MediaControlHost {
  getRoom(): Room | null;
  getCurrentChannelId(): number | null;
  getWs(): WsClient | null;
  getOnError(): ((message: string) => void) | null;
  getAudioPipeline(): AudioPipeline;
  getAudioElements(): AudioElements;
  getDeviceManager(): DeviceManager;
  getCameraState(): CameraTrackState;
  getScreenState(): ScreenTrackState;
  getPendingMicrophoneRoom(): Room | null;
  setPendingMicrophoneRoom(room: Room | null): void;
  configuredAudioOptions(
    channelId: number | null,
  ): { audioPreset: { maxBitrate: number } } | undefined;
}

export class MediaControl {
  constructor(private readonly host: MediaControlHost) {}

  // --- Host views, named as the pre-extraction fields so the bodies read the same ---

  private get _room(): Room | null {
    return this.host.getRoom();
  }
  private get _currentChannelId(): number | null {
    return this.host.getCurrentChannelId();
  }
  private get ws(): WsClient | null {
    return this.host.getWs();
  }
  private get onErrorCallback(): ((message: string) => void) | null {
    return this.host.getOnError();
  }
  private get _audioPipeline(): AudioPipeline {
    return this.host.getAudioPipeline();
  }
  private get _audioElements(): AudioElements {
    return this.host.getAudioElements();
  }
  private get _deviceManager(): DeviceManager {
    return this.host.getDeviceManager();
  }
  private get _cameraState(): CameraTrackState {
    return this.host.getCameraState();
  }
  private get _screenState(): ScreenTrackState {
    return this.host.getScreenState();
  }
  private get pendingMicrophoneRoom(): Room | null {
    return this.host.getPendingMicrophoneRoom();
  }
  private set pendingMicrophoneRoom(room: Room | null) {
    this.host.setPendingMicrophoneRoom(room);
  }
  private configuredAudioOptions(
    channelId: number | null,
  ): { audioPreset: { maxBitrate: number } } | undefined {
    return this.host.configuredAudioOptions(channelId);
  }

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
  async enableMicrophone(room: Room, enabled: boolean): Promise<void> {
    const publishOptions = enabled
      ? this.configuredAudioOptions(this._currentChannelId)
      : undefined;
    if (publishOptions === undefined) {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      return;
    }
    await room.localParticipant.setMicrophoneEnabled(enabled, undefined, publishOptions);
  }

  microphonePublishingAllowed(room: Room): boolean {
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
  async applyMicMuteState(muted: boolean): Promise<void> {
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
  reapplyMuteGain(): void {
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
}
