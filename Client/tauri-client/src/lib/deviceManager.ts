// DeviceManager — audio input/output device switching + hot-swap detection
//
// Delegates to Room.switchActiveDevice and rebuilds the audio pipeline
// after a device switch so the new source track flows through the GainNode.
// Monitors navigator.mediaDevices.ondevicechange for hot-swap (unplug/plug).

import { Room, type LocalAudioTrack, Track } from "livekit-client";
import { loadPref, savePref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";
import type { AudioPipeline } from "@lib/audioPipeline";

const log = createLogger("deviceManager");

/** Debounce interval for device change events (ms). */
const DEVICE_CHANGE_DEBOUNCE_MS = 500;

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
    if (this.room === null) return;
    log.info("Device change detected");

    try {
      const devices = await Room.getLocalDevices("audioinput");
      const savedInput = loadPref<string>("audioInputDevice", "");

      // Check if the saved input device was removed
      if (savedInput !== "" && !devices.some(d => d.deviceId === savedInput)) {
        log.warn("Saved audio input device removed — falling back to default", { savedInput });
        // Reset to default
        savePref("audioInputDevice", "");
        // Switch to default device
        try {
          await this.room.localParticipant.setMicrophoneEnabled(false);
          await this.room.localParticipant.setMicrophoneEnabled(true);
          try {
            this.audioPipeline?.setupAudioPipeline();
          } catch (pipelineErr) {
            log.warn("Audio pipeline setup failed after device fallback", pipelineErr);
            this.onToast?.("Audio pipeline error after device switch");
          }
          this.onToast?.("Audio device disconnected — switched to default");
        } catch (err) {
          log.error("Failed to fallback to default input device", err);
          this.onErrorCallback?.("No audio input device available");
        }
      }

      // Check output device
      const outputDevices = await Room.getLocalDevices("audiooutput");
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && !outputDevices.some(d => d.deviceId === savedOutput)) {
        log.warn("Saved audio output device removed — falling back to default", { savedOutput });
        savePref("audioOutputDevice", "");
        this.onToast?.("Audio output device disconnected — switched to default");
      }
    } catch (err) {
      log.warn("Failed to enumerate devices after change", err);
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
      log.error("Failed to switch input device", err);
      this.onErrorCallback?.("Failed to switch microphone");
    }
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    if (this.room !== null) await this.room.switchActiveDevice("audiooutput", deviceId);
    log.info("Switched output device", { deviceId });
  }
}
