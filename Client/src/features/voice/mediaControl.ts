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
  setShareDenied,
  bumpLocalCameraRev,
} from "../../stores/voice.store";
import { createLogger } from "../../lib/logger";
import type { AudioPipeline } from "../../lib/audioPipeline";
import type { AudioElements } from "../../lib/audioElements";
import { type DeviceManager, isMicPolicyGated } from "../../lib/deviceManager";
import { voiceText } from "../../i18n/voice";
import { CodecSwitchController } from "./codecSwitch";
import { CameraDeviceUnusable, CameraSwitchUnavailable } from "./cameraSwitch";
import { setH264GpuProfiles } from "../../lib/h264Profile";
import { h264GpuPublish } from "./videoCodec";
import { savePref } from "../../lib/preferences";
import {
  type VideoTrackDeps,
  type CameraTrackState,
  type ScreenTrackState,
  type StreamQuality,
  enableCamera as doEnableCamera,
  disableCamera as doDisableCamera,
  enableScreenshare as doEnableScreenshare,
  disableScreenshare as doDisableScreenshare,
  reconcileVideoFlags as doReconcileVideoFlags,
  inPlaceSourceChange,
  getLocalScreenshareStats,
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

  /** Camera switches run one at a time; a queued one that is no longer the
   *  latest pick is skipped, so the last pick wins. */
  private videoSwitch: Promise<void> = Promise.resolve();
  /** Keeps a live camera or share on a codec every viewer plays. */
  private readonly codecSwitch = new CodecSwitchController({
    getCameraState: () => this._cameraState,
    getScreenState: () => this._screenState,
    getDeps: () => this._videoTrackDeps,
    readScreenSenderSample: () => getLocalScreenshareStats(this._room),
    onSwitchError: (err) => log.warn("Codec switch failed", err),
  });
  private latestVideoDevice: string | null = null;

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
        this.reapplyMuteGain();
      },
    };
  }

  /** Retry microphone permission after being in listen-only mode. */
  async retryMicPermission(): Promise<void> {
    const room = this._room;
    if (room === null) return;
    // Nothing to retry in the AFK channel: it grants no microphone.
    if (voiceStore.getState().inAfkChannel === true) return;
    try {
      await this.enableMicrophone(room, true);
      if (this._room !== room) return;
      setListenOnly(false);
      // Honor deafened state — keep mic muted if user is deafened.
      // Also honor a moderator's server-mute and a genuine self-mute the
      // same way: a listen-only join publishes no audio track, so none of
      // these have anything to act on and persist silently — republishing
      // here must not hand the whole channel a fresh, unmuted track. Shares
      // applyMicMuteState's own gate rather than re-deriving a narrower one
      // (the setMuted() guard does not cover this direct
      // setMicrophoneEnabled call). An unpressed push-to-talk key needs
      // nothing here: the new track publishes behind its closed gate.
      if (isMicPolicyGated()) {
        await this.applyMicMuteState(true);
        if (this._room !== room) return;
        log.info("Microphone acquired but muted (mute/deafen/server-mute active)");
      } else {
        setLocalMuted(false);
        log.info("Microphone permission granted — exited listen-only mode");
      }
    } catch (err) {
      if (this._room !== room) return;
      log.warn("Microphone retry failed — still in listen-only mode", err);
      this.onErrorCallback?.(voiceText("mic.stillUnavailable"));
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
    // The AFK channel is listen-only; the mic control is locked muted there.
    if (!muted && voiceStore.getState().inAfkChannel === true) {
      log.debug("Ignoring unmute: AFK channel is listen-only");
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
   *  audio bitrate on any publish. Disabling publishes nothing, and
   *  a channel with no voice_config keeps LiveKit's own default, so both leave
   *  the call shaped exactly as it was before. On the web path the room's
   *  track creation attaches the mic processor before the publish
   *  (RoomLifecycle.createRoom), so the sender never carries a raw track. */
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
    return publishAllowed(room, Track.Source.Microphone);
  }

  /** Mute the SDK microphone track and tear down processing; capture/publish
   *  again when unmuting if the SFU withdrew the previous publication. */
  async applyMicMuteState(muted: boolean): Promise<void> {
    const room = this._room;
    if (room === null) return;
    if (muted) {
      this.pendingMicrophoneRoom = null;
      // Disable the mic through the SDK; the mic processor stays on the
      // track and resumes on the unmute restart. With stopMicTrackOnMute in the
      // Room's publishDefaults this stops the underlying capture track, so
      // the OS microphone in-use indicator goes out. The LiveKit publication
      // itself is NOT removed — it survives muted, and unmute re-acquires the
      // device (LocalAudioTrack.unmute -> restart). Only a screen-share track
      // actually unpublishes on end.
      await room.localParticipant.setMicrophoneEnabled(false);
      log.debug("Mic disabled (muted)");
    } else {
      // A moderator's server-mute (or the user's own other flag) is not this
      // call's to lift — setMuted/setDeafened only guard their own flag
      // before calling here, so this is the one place every re-enable path
      // (present and future) shares the full policy check. Push-to-talk is
      // not part of it: the room enables the microphone behind its gate
      // (AudioPipeline.setPttGated), which stays closed while the key is up.
      if (isMicPolicyGated()) {
        this.pendingMicrophoneRoom = null;
        log.debug("Skipping mic re-publish — still gated (mute/deafen/server-mute)");
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
      // server and every peer while publishing no audio at all.
      // Fall back into listen-only + muted so the state matches reality and
      // the existing "Grant Microphone" affordance (gated on listenOnly)
      // reappears as the recovery path.
      try {
        await this.enableMicrophone(room, true);
        if (this._room !== room) return;
        log.debug("Mic enabled (unmuted)");
      } catch (err) {
        if (this._room !== room) return;
        if (!this.microphonePublishingAllowed(room)) {
          this.pendingMicrophoneRoom = room;
          return;
        }
        setListenOnly(true);
        setLocalMuted(true);
        this.announceFallbackMute();
        log.warn("Mic re-publish failed — falling back to listen-only/muted", err);
        this.onErrorCallback?.(voiceText("mic.unavailableMuted"));
        return;
      }
    }
  }

  /** The unmute toggle already sent voice_mute{muted:false}; restate the
   *  fallback's mute so the server row and every peer's roster match. */
  private announceFallbackMute(): void {
    const ws = this.ws;
    if (ws === null || ws.getState() !== "connected") return;
    if (this._currentChannelId === null) return;
    ws.send({ type: "voice_mute", payload: { muted: true } });
  }

  async enableCamera(): Promise<void> {
    await this.startCamera(this._videoTrackDeps);
  }

  private async startCamera(deps: VideoTrackDeps): Promise<void> {
    await doEnableCamera(this._cameraState, deps);
    // A viewer may have joined while the enable was in flight.
    this.codecSwitch.kick();
  }

  async disableCamera(): Promise<void> {
    return doDisableCamera(this._cameraState, this._videoTrackDeps);
  }

  async enableScreenshare(): Promise<void> {
    await doEnableScreenshare(this._screenState, this._videoTrackDeps);
    this.codecSwitch.kick();
  }

  /** The session ended or is reconnecting: stop the live codec switch. */
  stopCodecSwitch(): void {
    this.codecSwitch.stop();
  }

  async disableScreenshare(): Promise<void> {
    return doDisableScreenshare(this._screenState, this._videoTrackDeps);
  }

  reconcileVideoFlags(camera: boolean, screenshare: boolean): void {
    doReconcileVideoFlags(this._cameraState, this._screenState, this._videoTrackDeps, {
      camera,
      screenshare,
    });
  }

  /** Stop the camera or share the grant no longer allows (a permission
   *  removed mid-call): the SFU stops carrying it, so the buttons and the
   *  server must not keep saying it is on. */
  dropDeniedVideo(room: Room): void {
    if (room !== this._room) return;
    const { localCamera, localScreenshare } = voiceStore.getState();
    if (localCamera && !publishAllowed(room, Track.Source.Camera)) void this.disableCamera();
    if (localScreenshare && !publishAllowed(room, Track.Source.ScreenShare))
      void this.disableScreenshare();
  }

  /** Share another window or screen without stopping (the web path swaps the
   *  browser capture; Linux asks the host to swap its own). */
  async changeScreenshareSource(): Promise<void> {
    const { changeScreenshareSource } = await import("./screenshareChange");
    return changeScreenshareSource(this._screenState, this._videoTrackDeps);
  }

  /** The live share's quality for this share only (the web path re-sizes the
   *  browser capture; Linux has the host re-size and republish its own). */
  async setScreenshareQuality(quality: StreamQuality): Promise<void> {
    const { setScreenshareQuality } = await import("./screenshareChange");
    return setScreenshareQuality(this._screenState, this._videoTrackDeps, quality);
  }

  /** The live share's quality, or null while it is not published. */
  getScreenshareQuality(): StreamQuality | null {
    return this._screenState.quality ?? null;
  }

  /** Whether the live share can change source without stopping. */
  canChangeScreenshareSource(): boolean {
    return (
      this._screenState.quality !== undefined || inPlaceSourceChange(this._screenState) !== null
    );
  }

  /** Use camera `deviceId` ("" = default) from now on and move a live camera
   *  onto it. The web track restarts in place (same publication); the Linux
   *  native capture is started again on the new device. */
  switchVideoDevice(deviceId: string): Promise<void> {
    savePref("videoInputDevice", deviceId);
    this.latestVideoDevice = deviceId;
    const run = this.videoSwitch.then(() =>
      this.latestVideoDevice === deviceId ? this.doSwitchVideoDevice(deviceId) : undefined,
    );
    this.videoSwitch = run.catch(() => {});
    return run;
  }

  private async doSwitchVideoDevice(deviceId: string): Promise<void> {
    const state = this._cameraState;
    const track = state.manualCameraTrack;
    // Camera off, or still starting: the saved choice is what it uses next.
    // An enable that read the choice just before this pick starts on the old
    // device; picking again moves it.
    if (track === null) return;
    // The device the live camera runs on (the native track knows it).
    const previous = "device" in track ? track.device : null;
    // The pick is unusable and the live camera stays: keep using its device.
    const keepPrevious = (): void => {
      if (previous === null || this.latestVideoDevice !== deviceId) return;
      savePref("videoInputDevice", previous);
      this.latestVideoDevice = previous;
    };
    // The restart path: stop, start on the saved device, republish.
    const restartCameraOn = async (): Promise<boolean> => {
      const generation = state.generation ?? 0;
      const failed = (): boolean =>
        state.manualCameraTrack === null && (state.generation ?? 0) === generation;
      if (previous === null) {
        await this.enableCamera();
      } else {
        // Hold the failure message: the previous camera may still come back.
        const held: string[] = [];
        await this.startCamera({ ...this._videoTrackDeps, onError: (msg) => held.push(msg) });
        if (failed()) {
          log.warn("Camera restart on the picked device failed, starting the previous one");
          const back = this.latestVideoDevice === deviceId;
          const newer = this.latestVideoDevice;
          // Start on the previous device. A pick made meanwhile stays the
          // saved choice and its queued switch moves the camera on from here.
          savePref("videoInputDevice", previous);
          await this.enableCamera();
          if (back) keepPrevious();
          else if (newer !== null) savePref("videoInputDevice", newer);
          if (!failed() && back) {
            this.onErrorCallback?.(voiceText("share.cameraSwitchFailed"));
          }
        } else {
          for (const msg of held) this.onErrorCallback?.(msg);
        }
      }
      // A failed restart already said so, but the server still has the
      // camera on: tell it the camera is off.
      if (failed()) {
        await this.disableCamera();
        return false;
      }
      return true;
    };
    try {
      if ("setDeviceId" in track) {
        const before = track.mediaStreamTrack;
        try {
          if (!(await track.setDeviceId(deviceId))) {
            log.warn("Camera restarted on another device than the one picked");
          }
        } catch (err) {
          if (err instanceof CameraDeviceUnusable) {
            log.warn("Picked camera gave no picture, keeping the live one", err);
            // A newer pick queued meanwhile moves the camera on: no message.
            if (this.latestVideoDevice !== deviceId) return;
            keepPrevious();
            this.onErrorCallback?.(voiceText("share.cameraSwitchFailed"));
            return;
          }
          if (!(err instanceof CameraSwitchUnavailable)) throw err;
          // The in-place switch could not run and the old camera still
          // publishes: restart on the new device instead.
          log.info("In-place camera switch unavailable, restarting", err);
          if (!(await restartCameraOn())) return;
          bumpLocalCameraRev();
          log.info("Camera device switched");
          return;
        }
        // The restart swaps the capture: unplug detection and the H.264
        // profiles a reconnect would republish with move with it.
        const now = track.mediaStreamTrack;
        if (now !== before) setH264GpuProfiles(now, h264GpuPublish(state.published ?? "vp8"));
        if (now !== before && state.manualCameraTrack === track && state.onCameraEnded) {
          now.addEventListener("ended", state.onCameraEnded, { once: true });
        }
        // The self tile holds the stopped capture: have it drawn again.
        if (now !== before && state.manualCameraTrack === track) bumpLocalCameraRev();
      } else {
        if (!(await restartCameraOn())) return;
        bumpLocalCameraRev();
      }
      log.info("Camera device switched");
    } catch (err) {
      if (state.manualCameraTrack !== track) return;
      log.warn("Camera device switch failed", err);
      await this.disableCamera();
      this.onErrorCallback?.(voiceText("share.cameraFailed"));
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

  getUserVolume(userId: number): number {
    return this._audioElements.getUserVolume(userId);
  }

  setUserLocalMute(userId: number, muted: boolean): void {
    this._audioElements.setUserLocalMute(userId, muted);
  }

  getUserLocalMute(userId: number): boolean {
    return this._audioElements.getUserLocalMute(userId);
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

  applyInputMode(): void {
    this._audioPipeline.applyInputMode();
  }

  /** Close or open the push-to-talk gate (AudioPipeline.setPttGated). */
  setPttGated(gated: boolean): void {
    this._audioPipeline.setPttGated(gated);
  }

  async reapplyAudioProcessing(): Promise<void> {
    return this._audioPipeline.reapplyAudioProcessing(this.onErrorCallback ?? undefined);
  }

  async reapplyEnhancedNoiseSuppression(): Promise<void> {
    return this._audioPipeline.reapplyEnhancedNoiseSuppression(this.onErrorCallback ?? undefined);
  }
}

/** Whether the SFU grant lets this room publish `source`; an empty source
 *  list means every source. */
export function publishAllowed(room: Room, source: Track.Source): boolean {
  const permissions = room.localParticipant.permissions;
  return (
    permissions === undefined ||
    (permissions.canPublish &&
      (permissions.canPublishSources.length === 0 ||
        permissions.canPublishSources.includes(Track.sourceToProto(source))))
  );
}

/** Mirror the grant's screen-share permission into the store for the share buttons. */
export function syncShareGrant(room: Room): void {
  setShareDenied(!publishAllowed(room, Track.Source.ScreenShare));
}
