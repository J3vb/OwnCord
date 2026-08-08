// DeviceManager — audio input/output device switching + hot-swap detection
//
// Delegates to Room.switchActiveDevice and rebuilds the audio pipeline
// after a device switch so the new source track flows through the GainNode.
// Monitors navigator.mediaDevices.ondevicechange for hot-swap (unplug/plug).

import { Room } from "livekit-client";
import { voiceStore } from "@stores/voice.store";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import type { AudioPipeline } from "@lib/audioPipeline";

const log = createLogger("deviceManager");

/** Debounce interval for device change events (ms). */
const DEVICE_CHANGE_DEBOUNCE_MS = 500;

/** True when a mute/deafen/server-mute/push-to-talk gate means the mic must
 *  stay off regardless of a caller's own request to (re-)enable it.
 *  livekit-client's setMicrophoneEnabled(true) is a bare track.unmute() when
 *  a muted-but-published track survives a toggle (only ScreenShare actually
 *  unpublishes) — no LocalTrackPublished/TrackUnmuted event fires for
 *  anything downstream to catch and correct, so every re-enable path has to
 *  check this itself instead of relying on one. Exported so LiveKitSession's
 *  own re-enable paths (setDeafened's unmute branch, retryMicPermission)
 *  share the same gate instead of each re-deriving it. */
export function isMicPolicyGated(): boolean {
  const s = voiceStore.getState();
  return (
    s.localMuted === true ||
    s.localDeafened === true ||
    s.localServerMuted === true ||
    s.pttGated === true
  );
}

export class DeviceManager {
  private room: Room | null = null;
  private audioPipeline: AudioPipeline | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private onToast: ((message: string) => void) | null = null;
  private deviceChangeHandler: (() => void) | null = null;
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;

  setRoom(room: Room | null): void {
    this.room = room;
    if (room !== null) {
      this.startDeviceChangeListener();
    } else {
      this.stopDeviceChangeListener();
    }
  }

  setAudioPipeline(pipeline: AudioPipeline | null): void {
    this.audioPipeline = pipeline;
  }

  setOnError(cb: ((message: string) => void) | null): void {
    this.onErrorCallback = cb;
  }

  setOnToast(cb: ((message: string) => void) | null): void {
    this.onToast = cb;
  }

  /** Toggle the mic off/on to force a fresh capture after a device change,
   *  skipping the re-enable when a mute/deafen/server-mute/PTT gate is
   *  active. Shared by handleDeviceChange's device-removed fallback and
   *  switchInputDevice('') — both drive the exact same false/true cycle, and
   *  both were unconditionally republishing a gated mic before this guard. */
  private async cycleMicForDeviceSwitch(room: Room): Promise<void> {
    await room.localParticipant.setMicrophoneEnabled(false);
    if (this.room !== room) return;
    if (isMicPolicyGated()) {
      log.debug("Skipping mic re-enable after device switch — muted/deafened/gated");
      return;
    }
    await room.localParticipant.setMicrophoneEnabled(true);
  }

  // --- Device change detection (hot-swap) ---

  private startDeviceChangeListener(): void {
    this.stopDeviceChangeListener();
    this.deviceChangeHandler = () => {
      // Debounce: device change events often fire in bursts
      if (this.deviceChangeTimer !== null) clearTimeout(this.deviceChangeTimer);
      this.deviceChangeTimer = setTimeout(() => {
        void this.handleDeviceChange();
      }, DEVICE_CHANGE_DEBOUNCE_MS);
    };
    navigator.mediaDevices?.addEventListener("devicechange", this.deviceChangeHandler);
    log.debug("Device change listener started");
  }

  private stopDeviceChangeListener(): void {
    if (this.deviceChangeHandler !== null) {
      navigator.mediaDevices?.removeEventListener("devicechange", this.deviceChangeHandler);
      this.deviceChangeHandler = null;
    }
    if (this.deviceChangeTimer !== null) {
      clearTimeout(this.deviceChangeTimer);
      this.deviceChangeTimer = null;
    }
  }

  private async handleDeviceChange(): Promise<void> {
    // Snapshot the room this attempt started for. `this.room` is a mutable
    // field that a system-driven reconnect (or session teardown) can
    // reassign out from under an in-flight await below — re-reading it
    // after each await would apply the fallback to the wrong Room, or throw
    // a null-deref that surfaces as a misleading "No audio input device
    // available" error after the user already left voice (v096).
    const room = this.room;
    if (room === null) return;
    log.info("Device change detected");

    try {
      const devices = await Room.getLocalDevices("audioinput");
      if (this.room !== room) return;
      const savedInput = loadPref<string>("audioInputDevice", "");

      // Check if the saved input device was removed
      if (savedInput !== "" && !devices.some((d) => d.deviceId === savedInput)) {
        log.warn("Saved audio input device removed — falling back to default", { savedInput });
        // Reset to default
        savePref("audioInputDevice", "");
        // Switch to default device
        try {
          await this.cycleMicForDeviceSwitch(room);
          if (this.room !== room) return;
          try {
            this.audioPipeline?.setupAudioPipeline();
          } catch (pipelineErr) {
            log.warn("Audio pipeline setup failed after device fallback", pipelineErr);
            this.onToast?.("Audio pipeline error after device switch");
          }
          this.onToast?.("Audio device disconnected — switched to default");
        } catch (err) {
          if (this.room !== room) return;
          log.error("Failed to fallback to default input device", err);
          this.onErrorCallback?.("No audio input device available");
        }
      }

      // Check output device
      const outputDevices = await Room.getLocalDevices("audiooutput");
      if (this.room !== room) return;
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && !outputDevices.some((d) => d.deviceId === savedOutput)) {
        log.warn("Saved audio output device removed — falling back to default", { savedOutput });
        savePref("audioOutputDevice", "");
        this.onToast?.("Audio output device disconnected — switched to default");
      }
    } catch (err) {
      log.warn("Failed to enumerate devices after change", err);
    }
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    const room = this.room;
    if (room === null) {
      log.debug("Skipping input device switch — no active voice session");
      return;
    }
    try {
      if (deviceId) {
        await room.switchActiveDevice("audioinput", deviceId);
      } else {
        await this.cycleMicForDeviceSwitch(room);
      }
      if (this.room !== room) return;
      // Rebuild audio pipeline (source track changed after device switch)
      try {
        this.audioPipeline?.setupAudioPipeline();
      } catch (pipelineErr) {
        log.warn("Audio pipeline setup failed after input device switch", pipelineErr);
        this.onToast?.("Audio pipeline error after device switch");
      }
      // Re-apply or remove RNNoise processor based on current setting
      const enhancedNS = loadPref<boolean>("enhancedNoiseSuppression", false);
      if (enhancedNS) {
        await this.audioPipeline?.applyNoiseSuppressor();
      } else {
        await this.audioPipeline?.removeNoiseSuppressor();
      }
      log.info("Switched input device", { deviceId });
    } catch (err) {
      if (this.room !== room) return;
      log.error("Failed to switch input device", err);
      this.onErrorCallback?.("Failed to switch microphone");
    }
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    const room = this.room;
    if (room === null) {
      log.debug("Skipping output device switch — no active voice session");
      return;
    }
    // Mirrors switchInputDevice: switchActiveDevice rejects where setSinkId
    // isn't available, and the settings tab fires this as a bare `void` call,
    // so an unhandled rejection would leave the user staring at a selection
    // that never took effect.
    try {
      await room.switchActiveDevice("audiooutput", deviceId);
      if (this.room !== room) return;
      log.info("Switched output device", { deviceId });
    } catch (err) {
      if (this.room !== room) return;
      log.error("Failed to switch output device", err);
      this.onErrorCallback?.("Failed to switch speaker");
    }
  }
}
