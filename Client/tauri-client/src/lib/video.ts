// =============================================================================
// Video Device Manager — enumerate cameras, acquire streams, stop capture
// =============================================================================

import { createLogger } from "@lib/logger";

const log = createLogger("video");

export interface VideoDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: "videoinput";
}

export interface VideoManager {
  enumerateDevices(): Promise<readonly VideoDevice[]>;
  getCameraStream(deviceId?: string): Promise<MediaStream>;
  stopCameraStream(): void;
  getCurrentStream(): MediaStream | null;
  onDeviceChange(callback: (devices: readonly VideoDevice[]) => void): () => void;
  destroy(): void;
}

type DeviceChangeCallback = (devices: readonly VideoDevice[]) => void;

function toVideoDevice(info: MediaDeviceInfo): VideoDevice | null {
  if (info.kind !== "videoinput") return null;
  return {
    deviceId: info.deviceId,
    label: info.label || `Camera (${info.deviceId.slice(0, 8)})`,
    kind: "videoinput",
  };
}

export function createVideoManager(): VideoManager {
  let currentStream: MediaStream | null = null;
  let destroyed = false;

  const deviceChangeCallbacks = new Set<DeviceChangeCallback>();

  async function listVideoDevices(): Promise<readonly VideoDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices: VideoDevice[] = [];
    for (const d of devices) {
      const mapped = toVideoDevice(d);
      if (mapped !== null) {
        videoDevices.push(mapped);
      }
    }
    return videoDevices;
  }

  function handleDeviceChange(): void {
    if (destroyed) return;
    void listVideoDevices().then((devices) => {
      log.info("Video device change detected", {
        cameras: devices.length,
      });
      for (const cb of deviceChangeCallbacks) {
        cb(devices);
      }
    });
  }

  navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

  return {
    async enumerateDevices(): Promise<readonly VideoDevice[]> {
      if (destroyed) throw new Error("VideoManager has been destroyed");
      return listVideoDevices();
    },

    async getCameraStream(deviceId?: string): Promise<MediaStream> {
      if (destroyed) throw new Error("VideoManager has been destroyed");

      // Stop any existing stream before acquiring a new one
      if (currentStream !== null) {
        for (const track of currentStream.getTracks()) {
          track.stop();
        }
        currentStream = null;
      }

      const constraints: MediaStreamConstraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          deviceId: deviceId !== undefined ? { exact: deviceId } : undefined,
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentStream = stream;

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack !== undefined) {
        const settings = videoTrack.getSettings();
        log.info("Camera acquired", {
          deviceId: settings.deviceId ?? deviceId ?? null,
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
        });
      }

      return stream;
    },

    stopCameraStream(): void {
      if (currentStream === null) return;
      for (const track of currentStream.getTracks()) {
        track.stop();
      }
      currentStream = null;
      log.info("Camera stream stopped");
    },

    getCurrentStream(): MediaStream | null {
      return currentStream;
    },

    onDeviceChange(callback: DeviceChangeCallback): () => void {
      deviceChangeCallbacks.add(callback);
      return () => { deviceChangeCallbacks.delete(callback); };
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);

      log.debug("VideoManager destroying", { hasStream: currentStream !== null });
      if (currentStream !== null) {
        for (const track of currentStream.getTracks()) {
          track.stop();
        }
        currentStream = null;
      }
      deviceChangeCallbacks.clear();
    },
  };
}
