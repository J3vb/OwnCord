// The session's media and device control surface: mute and deafen, camera,
// screen share, device switching, volumes and the audio pipeline's settings,
// each delegating to MediaControl or AudioPipeline.
import type { MediaControl } from "./mediaControl";
import type { AudioPipeline } from "@lib/voice/audioPipeline";
import { isMicPolicyGated } from "@lib/voice/deviceManager";
import { createLogger } from "@lib/logger";
import type { StreamQuality } from "./screenShare";
import { voiceStore, setPttGated as setPttGatedState } from "@stores/voice.store";
import { SessionShare } from "./sessionShare";

const log = createLogger("livekitSession");

export abstract class SessionMedia extends SessionShare {
  protected abstract readonly _media: MediaControl;
  protected abstract readonly _audioPipeline: AudioPipeline;

  /** Retry microphone permission after being in listen-only mode. */
  async retryMicPermission(): Promise<void> {
    return this._media.retryMicPermission();
  }

  // --- Media and device control (delegated to MediaControl) ---

  setMuted(muted: boolean): void {
    this._media.setMuted(muted);
  }

  setDeafened(deafened: boolean): void {
    this._media.setDeafened(deafened);
  }

  protected async applyMicMuteState(muted: boolean): Promise<void> {
    return this._media.applyMicMuteState(muted);
  }

  /** A gate no mic control drives changed (a phone call's hold began or
   *  ended): close the microphone, or open it again if nothing else keeps it
   *  closed. The user's mute, the saved state and the server hear nothing. A
   *  call joined listen-only has no microphone to open, and neither has one
   *  that is over. */
  syncMicrophoneGate(): void {
    const gated = isMicPolicyGated();
    const voice = voiceStore.getState();
    if (!gated && (voice.listenOnly || voice.currentChannelId === null)) return;
    this.applyMicMuteState(gated).catch((e) => log.warn("Microphone gate sync failed", e));
  }

  async enableCamera(): Promise<void> {
    return this._media.enableCamera();
  }

  async disableCamera(): Promise<void> {
    return this._media.disableCamera();
  }

  async enableScreenshare(): Promise<void> {
    return this._media.enableScreenshare();
  }

  async disableScreenshare(): Promise<void> {
    return this._media.disableScreenshare();
  }

  /** `ready`'s camera/share flags for this user, checked against what we send. */
  reconcileVideoFlags(camera: boolean, screenshare: boolean): void {
    this._media.reconcileVideoFlags(camera, screenshare);
  }

  changeScreenshareSource(): Promise<void> {
    return this._media.changeScreenshareSource();
  }

  setScreenshareQuality(quality: StreamQuality): Promise<void> {
    return this._media.setScreenshareQuality(quality);
  }

  getScreenshareQuality(): StreamQuality | null {
    return this._media.getScreenshareQuality();
  }

  canChangeScreenshareSource(): boolean {
    return this._media.canChangeScreenshareSource();
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    return this._media.switchInputDevice(deviceId);
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    return this._media.switchOutputDevice(deviceId);
  }

  async switchVideoDevice(deviceId: string): Promise<void> {
    return this._media.switchVideoDevice(deviceId);
  }

  setUserVolume(userId: number, volume: number): void {
    this._media.setUserVolume(userId, volume);
  }

  getUserVolume(userId: number): number {
    return this._media.getUserVolume(userId);
  }

  setUserLocalMute(userId: number, muted: boolean): void {
    this._media.setUserLocalMute(userId, muted);
  }

  getUserLocalMute(userId: number): boolean {
    return this._media.getUserLocalMute(userId);
  }

  setScreenshareAudioVolume(userId: number, volume: number): void {
    this._media.setScreenshareAudioVolume(userId, volume);
  }

  getScreenshareAudioVolume(userId: number): number {
    return this._media.getScreenshareAudioVolume(userId);
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this._media.muteScreenshareAudio(userId, muted);
  }

  getScreenshareAudioMuted(userId: number): boolean {
    return this._media.getScreenshareAudioMuted(userId);
  }

  protected reapplyMuteGain(): void {
    this._media.reapplyMuteGain();
  }

  setInputVolume(volume: number): void {
    this._media.setInputVolume(volume);
  }

  readonly setSileroBufferMs = (ms: number): void => this._audioPipeline.setSileroBufferMs(ms);

  /** Hear the call capture's level reports where the room captures on its
   *  own (Linux native engine). Returns the unsubscribe. */
  onNativeInputLevel(listener: (rms: number | null, open: boolean) => void): () => void {
    return this._audioPipeline.onRoomInputLevel(listener);
  }

  setOutputVolume(volume: number): void {
    this._media.setOutputVolume(volume);
  }

  setVoiceSensitivity(sensitivity: number): void {
    this._media.setVoiceSensitivity(sensitivity);
  }

  /** Re-run the sensitivity gate for the saved input mode (Voice Activity
   *  gates on sensitivity, Push to Talk does not). */
  applyInputMode(): void {
    this._media.applyInputMode();
  }

  /** Push-to-talk: close (key up) or open (key down) the gate — the mic
   *  processor's, or the native room's own (AudioPipeline.setPttGated).
   *  Recorded in the store for the widget, applied to the live processor and
   *  to every one attached later. */
  setPttGated(gated: boolean): void {
    setPttGatedState(gated);
    this._media.setPttGated(gated);
  }

  async reapplyAudioProcessing(): Promise<void> {
    return this._media.reapplyAudioProcessing();
  }

  /** Route the live mic processor through or around RNNoise for the saved
   *  preference, without restarting the capture. */
  async reapplyEnhancedNoiseSuppression(): Promise<void> {
    return this._media.reapplyEnhancedNoiseSuppression();
  }

  /** The live microphone capture's settings, for Settings to name it. */
  getLocalMicSettings(): MediaTrackSettings | null {
    return this._audioPipeline.micSettings;
  }
}
