// DeviceManager — audio input/output device switching + hot-swap detection
//
// Delegates to Room.switchActiveDevice and rebuilds the audio pipeline
// after a device switch so the new source track flows through the GainNode.
// Monitors navigator.mediaDevices.ondevicechange for hot-swap: an unplugged
// saved device falls back to the default and is switched back to on replug.

import { Room } from "livekit-client";
import { voiceStore } from "@stores/voice.store";
import { loadPref } from "@lib/preferences";
import { createLogger } from "@lib/logger";
import type { AudioPipeline } from "@lib/audioPipeline";
import { nativeAudioDevices } from "../features/voice/native/devices";
import { voiceText } from "../i18n/voice";

const log = createLogger("deviceManager");

/** Debounce interval for device change events (ms). */
const DEVICE_CHANGE_DEBOUNCE_MS = 500;

/** True when a mute/deafen/server-mute means the mic must stay off
 *  regardless of a caller's own request to (re-)enable it. Push-to-talk is
 *  not part of it: a re-enabled microphone comes up behind its gate
 *  (AudioPipeline.setPttGated), which stays closed while the key is up.
 *  Re-enabling never re-publishes: setMicrophoneEnabled(true) on an existing
 *  publication is a track.unmute() (only ScreenShare actually unpublishes),
 *  and with the Room's stopMicTrackOnMute that same call re-acquires the
 *  device the mute stopped rather than resuming a live one. Either way no
 *  LocalTrackPublished/TrackUnmuted event fires for anything downstream to
 *  catch and correct, so every re-enable path has to check this itself
 *  instead of relying on one. Exported so LiveKitSession's own re-enable
 *  paths (setDeafened's unmute branch, retryMicPermission) share the same
 *  gate instead of each re-deriving it. */
export function isMicPolicyGated(): boolean {
  const s = voiceStore.getState();
  return s.localMuted === true || s.localDeafened === true || s.localServerMuted === true;
}

export class DeviceManager {
  private room: Room | null = null;
  private audioPipeline: AudioPipeline | null = null;
  private onErrorCallback: ((message: string) => void) | null = null;
  private onToast: ((message: string) => void) | null = null;
  private deviceChangeHandler: (() => void) | null = null;
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The saved device id each kind fell back to the default from after it
   *  was unplugged. Kept across rooms so a reconnect still restores it. */
  private fallbackFrom: { audioinput?: string; audiooutput?: string } = {};

  setRoom(room: Room | null): void {
    this.room = room;
    if (room !== null) {
      this.startDeviceChangeListener();
      void this.reconcileFallbacks(room);
    } else {
      this.stopDeviceChangeListener();
    }
  }

  /** Match the fallback record to the devices listed when a room attaches.
   *  Join and reconnect open the saved device when it is listed and degrade
   *  to the default when it is not, so a missing saved device counts as
   *  fallen back (restored when it is listed again) and a listed one does
   *  not (its next unplug falls back again). */
  private async reconcileFallbacks(room: Room): Promise<void> {
    const saved = [
      ["audioinput", "audioInputDevice"],
      ["audiooutput", "audioOutputDevice"],
    ] as const;
    await Promise.all(
      saved.map(async ([kind, key]) => {
        const deviceId = loadPref<string>(key, "");
        if (deviceId === "") return;
        const devices = (await nativeAudioDevices(kind)) ?? (await Room.getLocalDevices(kind));
        if (this.room !== room || loadPref<string>(key, "") !== deviceId) return;
        if (devices.some((d) => d.deviceId === deviceId)) delete this.fallbackFrom[kind];
        else this.fallbackFrom[kind] = deviceId;
      }),
    ).catch((err: unknown) => {
      log.warn("Failed to enumerate devices on room attach", err);
    });
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

  /** Reset the capture device to the system default, then toggle the mic
   *  off/on to force a fresh capture, skipping the re-enable when a
   *  mute/deafen/server-mute is active. Shared by
   *  handleDeviceChange's device-removed fallback and switchInputDevice('')
   *  — both drive the exact same reset + false/true cycle, and both were
   *  unconditionally republishing a gated mic before this guard. */
  private async cycleMicForDeviceSwitch(room: Room): Promise<void> {
    // A previous switchActiveDevice pins audioCaptureDefaults.deviceId as an
    // exact constraint that survives the off/on cycle, so the cycle alone
    // re-acquires the old device. Reset the pin to the system default first;
    // exact=false keeps the constraint ideal so this degrades gracefully
    // where no "default" device id exists.
    await room.switchActiveDevice("audioinput", "default", false);
    if (this.room !== room) return;
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
    if (room.state === "connecting" || room.state === "disconnected") {
      await this.reconcileFallbacks(room);
      return;
    }
    log.info("Device change detected");

    try {
      const nativeInputs = await nativeAudioDevices("audioinput");
      const devices = nativeInputs ?? (await Room.getLocalDevices("audioinput"));
      if (this.room !== room) return;
      // Kinds this run switched back, which the native re-apply below skips.
      const restored = new Set<MediaDeviceKind>();
      const savedInput = loadPref<string>("audioInputDevice", "");
      const inputListed = devices.some((d) => d.deviceId === savedInput);

      if (savedInput !== "" && !inputListed && this.fallbackFrom.audioinput !== savedInput) {
        log.warn("Saved audio input device removed — falling back to default", { savedInput });
        this.fallbackFrom.audioinput = savedInput;
        await this.fallBackToDefaultInput(room);
        if (this.room !== room) return;
      } else if (inputListed && this.fallbackFrom.audioinput === savedInput) {
        log.info("Saved audio input device is back — switching to it", { savedInput });
        delete this.fallbackFrom.audioinput;
        restored.add("audioinput");
        try {
          // While muted this only records the device (OC-0474).
          await room.switchActiveDevice("audioinput", savedInput);
          if (this.room !== room) return;
          this.setupPipelineAfterSwitch();
        } catch (err) {
          if (this.room !== room) return;
          // The failed restart already stopped the capture: re-acquire the
          // default rather than leave a dead mic that reads as unmuted.
          log.warn("Failed to switch back to the saved input device", err);
          this.fallbackFrom.audioinput = savedInput;
          await this.fallBackToDefaultInput(room);
          if (this.room !== room) return;
        }
      }

      // Check output device
      const outputDevices =
        (await nativeAudioDevices("audiooutput")) ?? (await Room.getLocalDevices("audiooutput"));
      if (this.room !== room) return;
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      const outputListed = outputDevices.some((d) => d.deviceId === savedOutput);
      // LiveKit's own undebounced devicechange handler moves output to the
      // default the moment the saved device disappears, so a replug inside
      // our debounce finds it listed with no fallback recorded. The native
      // room has no getActiveDevice; its re-apply loop below covers it.
      const activeOutput = room.getActiveDevice?.("audiooutput");
      if (outputListed && activeOutput !== undefined && activeOutput !== savedOutput) {
        this.fallbackFrom.audiooutput = savedOutput;
      }
      if (savedOutput !== "" && !outputListed && this.fallbackFrom.audiooutput !== savedOutput) {
        log.warn("Saved audio output device removed — falling back to default", { savedOutput });
        try {
          await room.switchActiveDevice("audiooutput", "");
          if (this.room !== room || loadPref<string>("audioOutputDevice", "") !== savedOutput)
            return;
          this.fallbackFrom.audiooutput = savedOutput;
          this.onToast?.(voiceText("device.outputDisconnected"));
        } catch (err) {
          if (this.room !== room || loadPref<string>("audioOutputDevice", "") !== savedOutput)
            return;
          log.error("Failed to fallback to default output device", err);
          this.onErrorCallback?.(voiceText("device.defaultSpeakerFailed"));
        }
      } else if (outputListed && this.fallbackFrom.audiooutput === savedOutput) {
        log.info("Saved audio output device is back — switching to it", { savedOutput });
        delete this.fallbackFrom.audiooutput;
        restored.add("audiooutput");
        try {
          await room.switchActiveDevice("audiooutput", savedOutput);
        } catch (err) {
          if (this.room !== room) return;
          log.error("Failed to switch back to the saved output device", err);
          this.fallbackFrom.audiooutput = savedOutput;
          this.onErrorCallback?.(voiceText("device.speakerFailed"));
        }
        if (this.room !== room) return;
      }

      // The native backend opens its capture and playout streams on concrete
      // devices, so the saved devices are re-applied after a hot-plug, a
      // saved "System default" included: that moves capture and playout to a
      // hot-plugged default (the backend leaves a stream on an unchanged
      // device alone).
      if (nativeInputs === null) return;
      const saved = [
        ["audioinput", "audioInputDevice", devices],
        ["audiooutput", "audioOutputDevice", outputDevices],
      ] as const;
      for (const [kind, key, listed] of saved) {
        const pref = loadPref<string>(key, "");
        const deviceId = this.fallbackFrom[kind] === pref ? "" : pref;
        const reapply = deviceId === "" || listed.some((d) => d.deviceId === deviceId);
        if (!reapply || restored.has(kind)) continue;
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential by design: the room-supersession check must run between the two switches
          await room.switchActiveDevice(kind, deviceId);
        } catch (err) {
          log.warn("Failed to re-apply saved device after change", { kind, err });
        }
        if (this.room !== room) return;
      }
    } catch (err) {
      log.warn("Failed to enumerate devices after change", err);
    }
  }

  /** Move capture to the system default while the saved input is unusable.
   *  The pref keeps the user's pick so the device is restored when it is
   *  listed again (DP-31). */
  private async fallBackToDefaultInput(room: Room): Promise<void> {
    try {
      await this.cycleMicForDeviceSwitch(room);
      if (this.room !== room) return;
      this.setupPipelineAfterSwitch();
      this.onToast?.(voiceText("device.inputDisconnected"));
    } catch (err) {
      if (this.room !== room) return;
      log.error("Failed to fallback to default input device", err);
      this.onErrorCallback?.(voiceText("device.noInput"));
    }
  }

  /** The mic processor rides the SDK's restart: its gated output stays on
   *  the sender and only the capture behind it changed. This only attaches
   *  one where a track has none. */
  private setupPipelineAfterSwitch(): void {
    try {
      this.audioPipeline?.setupAudioPipeline();
    } catch (pipelineErr) {
      log.warn("Audio pipeline setup failed after device switch", pipelineErr);
      this.onToast?.(voiceText("device.pipelineError"));
    }
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    // A manual pick replaces whatever a hot-unplug fell back from.
    delete this.fallbackFrom.audioinput;
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
      this.setupPipelineAfterSwitch();
      log.info("Switched input device", { deviceId });
    } catch (err) {
      if (this.room !== room) return;
      log.error("Failed to switch input device", err);
      this.onErrorCallback?.(voiceText("device.micFailed"));
    }
  }

  async switchOutputDevice(deviceId: string): Promise<void> {
    delete this.fallbackFrom.audiooutput;
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
      this.onErrorCallback?.(voiceText("device.speakerFailed"));
    }
  }
}
