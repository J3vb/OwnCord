/**
 * Unit tests for the Video Device Manager.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createVideoManager } from "@lib/video";
import type { VideoManager } from "@lib/video";

// ---------------------------------------------------------------------------
// Mock navigator.mediaDevices
// ---------------------------------------------------------------------------

function createMockTrack(kind: string): MediaStreamTrack {
  return {
    kind,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "cam-1", width: 1280, height: 720, frameRate: 30 }),
  } as unknown as MediaStreamTrack;
}

function createMockStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

const mockDevices: MediaDeviceInfo[] = [
  { deviceId: "cam-1", label: "Front Camera", kind: "videoinput", groupId: "g1", toJSON: () => ({}) },
  { deviceId: "cam-2", label: "Back Camera", kind: "videoinput", groupId: "g2", toJSON: () => ({}) },
  { deviceId: "mic-1", label: "Microphone", kind: "audioinput", groupId: "g3", toJSON: () => ({}) },
  { deviceId: "spk-1", label: "Speakers", kind: "audiooutput", groupId: "g4", toJSON: () => ({}) },
];

let deviceChangeListeners: Array<() => void>;

beforeEach(() => {
  deviceChangeListeners = [];

  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      enumerateDevices: vi.fn().mockResolvedValue(mockDevices),
      getUserMedia: vi.fn().mockResolvedValue(
        createMockStream([createMockTrack("video")]),
      ),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "devicechange") deviceChangeListeners.push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        deviceChangeListeners = deviceChangeListeners.filter((h) => h !== handler);
      }),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VideoManager", () => {
  let manager: VideoManager;

  beforeEach(() => {
    manager = createVideoManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe("enumerateDevices", () => {
    it("returns only videoinput devices", async () => {
      const devices = await manager.enumerateDevices();
      expect(devices).toHaveLength(2);
      expect(devices.every((d) => d.kind === "videoinput")).toBe(true);
    });

    it("returns deviceId and label for each device", async () => {
      const devices = await manager.enumerateDevices();
      expect(devices[0]).toEqual({
        deviceId: "cam-1",
        label: "Front Camera",
        kind: "videoinput",
      });
      expect(devices[1]).toEqual({
        deviceId: "cam-2",
        label: "Back Camera",
        kind: "videoinput",
      });
    });
  });

  describe("getCameraStream", () => {
    it("calls getUserMedia with correct video constraints and no audio", async () => {
      await manager.getCameraStream("cam-1");

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          deviceId: { exact: "cam-1" },
        },
        audio: false,
      });
    });

    it("uses default device when no deviceId is provided", async () => {
      await manager.getCameraStream();

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          deviceId: undefined,
        },
        audio: false,
      });
    });

    it("returns the media stream", async () => {
      const stream = await manager.getCameraStream();
      expect(stream).toBeDefined();
      expect(stream.getVideoTracks()).toHaveLength(1);
    });

    it("stores the stream as current stream", async () => {
      expect(manager.getCurrentStream()).toBeNull();
      const stream = await manager.getCameraStream();
      expect(manager.getCurrentStream()).toBe(stream);
    });

    it("stops previous stream when acquiring a new one", async () => {
      const track1 = createMockTrack("video");
      const stream1 = createMockStream([track1]);
      vi.mocked(navigator.mediaDevices.getUserMedia)
        .mockResolvedValueOnce(stream1)
        .mockResolvedValueOnce(createMockStream([createMockTrack("video")]));

      await manager.getCameraStream("cam-1");
      await manager.getCameraStream("cam-2");

      expect(track1.stop).toHaveBeenCalled();
    });
  });

  describe("stopCameraStream", () => {
    it("stops all tracks on the current stream", async () => {
      const track = createMockTrack("video");
      const stream = createMockStream([track]);
      vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream);

      await manager.getCameraStream();
      manager.stopCameraStream();

      expect(track.stop).toHaveBeenCalled();
      expect(manager.getCurrentStream()).toBeNull();
    });

    it("does nothing when no stream is active", () => {
      // Should not throw
      manager.stopCameraStream();
      expect(manager.getCurrentStream()).toBeNull();
    });
  });

  describe("onDeviceChange", () => {
    it("registers a listener for device changes", () => {
      expect(navigator.mediaDevices.addEventListener).toHaveBeenCalledWith(
        "devicechange",
        expect.any(Function),
      );
    });

    it("notifies callbacks with only video devices on change", async () => {
      const callback = vi.fn();
      manager.onDeviceChange(callback);

      // Trigger the device change event
      for (const listener of deviceChangeListeners) {
        listener();
      }

      // Wait for async enumeration
      await vi.waitFor(() => expect(callback).toHaveBeenCalled());

      const devices = callback.mock.calls[0]![0];
      expect(devices).toHaveLength(2);
      expect(devices.every((d: { kind: string }) => d.kind === "videoinput")).toBe(true);
    });

    it("returns an unsubscribe function", async () => {
      const callback = vi.fn();
      const unsub = manager.onDeviceChange(callback);
      unsub();

      for (const listener of deviceChangeListeners) {
        listener();
      }

      // Give time for any async callback
      await new Promise((r) => { setTimeout(r, 50); });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("removes the devicechange event listener", () => {
      manager.destroy();
      expect(navigator.mediaDevices.removeEventListener).toHaveBeenCalledWith(
        "devicechange",
        expect.any(Function),
      );
    });

    it("stops the current stream on destroy", async () => {
      const track = createMockTrack("video");
      const stream = createMockStream([track]);
      vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(stream);

      await manager.getCameraStream();
      manager.destroy();

      expect(track.stop).toHaveBeenCalled();
    });

    it("throws on enumerateDevices after destroy", async () => {
      manager.destroy();
      await expect(manager.enumerateDevices()).rejects.toThrow("VideoManager has been destroyed");
    });

    it("throws on getCameraStream after destroy", async () => {
      manager.destroy();
      await expect(manager.getCameraStream()).rejects.toThrow("VideoManager has been destroyed");
    });
  });
});
