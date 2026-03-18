// =============================================================================
// Audio Device Manager — enumerate devices, acquire streams, set output
// =============================================================================

import { loadPref } from "@components/settings/helpers";
import { createLogger } from "@lib/logger";

const log = createLogger("audio");

export interface AudioDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: "audioinput" | "audiooutput";
}

export interface AudioManager {
  enumerateDevices(): Promise<readonly AudioDevice[]>;
  getUserMedia(deviceId?: string): Promise<MediaStream>;
  setOutputDevice(element: HTMLAudioElement, deviceId: string): Promise<void>;
  getInputDeviceId(): string | null;
  getOutputDeviceId(): string | null;
  onDeviceChange(callback: (devices: readonly AudioDevice[]) => void): () => void;
  destroy(): void;
}

type DeviceChangeCallback = (devices: readonly AudioDevice[]) => void;

function toAudioDevice(info: MediaDeviceInfo): AudioDevice | null {
  if (info.kind !== "audioinput" && info.kind !== "audiooutput") return null;
  return {
    deviceId: info.deviceId,
    label: info.label || `${info.kind === "audioinput" ? "Microphone" : "Speaker"} (${info.deviceId.slice(0, 8)})`,
    kind: info.kind,
  };
}

export function createAudioManager(): AudioManager {
  let currentInputDeviceId: string | null = null;
  let currentOutputDeviceId: string | null = null;
  let destroyed = false;

  const activeStreams = new Set<MediaStream>();
  const deviceChangeCallbacks = new Set<DeviceChangeCallback>();

  async function listAudioDevices(): Promise<readonly AudioDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices: AudioDevice[] = [];
    for (const d of devices) {
      const mapped = toAudioDevice(d);
      if (mapped !== null) {
        audioDevices.push(mapped);
      }
    }
    return audioDevices;
  }

  function handleDeviceChange(): void {
    if (destroyed) return;
    void listAudioDevices().then((devices) => {
      log.info("Audio device change detected", {
        inputs: devices.filter((d) => d.kind === "audioinput").length,
        outputs: devices.filter((d) => d.kind === "audiooutput").length,
      });
      for (const cb of deviceChangeCallbacks) {
        cb(devices);
      }
    });
  }

  navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

  return {
    async enumerateDevices(): Promise<readonly AudioDevice[]> {
      if (destroyed) throw new Error("AudioManager has been destroyed");
      return listAudioDevices();
    },

    async getUserMedia(deviceId?: string): Promise<MediaStream> {
      if (destroyed) throw new Error("AudioManager has been destroyed");

      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId !== undefined ? { exact: deviceId } : undefined,
          echoCancellation: loadPref<boolean>("echoCancellation", true),
          noiseSuppression: loadPref<boolean>("noiseSuppression", true),
          autoGainControl: loadPref<boolean>("autoGainControl", true),
        },
        video: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStreams.add(stream);

      // Determine actual device ID from the track settings
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack !== undefined) {
        const settings = audioTrack.getSettings();
        currentInputDeviceId = settings.deviceId ?? deviceId ?? null;
        log.info("Microphone acquired", {
          deviceId: currentInputDeviceId,
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
        });
      }

      return stream;
    },

    async setOutputDevice(element: HTMLAudioElement, deviceId: string): Promise<void> {
      if (destroyed) throw new Error("AudioManager has been destroyed");

      // setSinkId is not available in all browsers; check before calling
      if (typeof element.setSinkId !== "function") {
        throw new Error("Audio output device selection is not supported in this browser");
      }
      await element.setSinkId(deviceId);
      currentOutputDeviceId = deviceId;
    },

    getInputDeviceId(): string | null {
      return currentInputDeviceId;
    },

    getOutputDeviceId(): string | null {
      return currentOutputDeviceId;
    },

    onDeviceChange(callback: DeviceChangeCallback): () => void {
      deviceChangeCallbacks.add(callback);
      return () => { deviceChangeCallbacks.delete(callback); };
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);

      // Stop all tracks on all active streams
      log.debug("AudioManager destroying", { activeStreams: activeStreams.size });
      for (const stream of activeStreams) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      activeStreams.clear();
      deviceChangeCallbacks.clear();
      currentInputDeviceId = null;
      currentOutputDeviceId = null;
    },
  };
}
