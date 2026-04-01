import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Hoisted mocks ---

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
  savePref: (key: string, val: unknown) => mockSavePref(key, val),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockGetLocalDevices = vi.fn();

vi.mock("livekit-client", () => ({
  Room: Object.assign(vi.fn(), {
    getLocalDevices: (...args: unknown[]) => mockGetLocalDevices(...args),
  }),
}));

import { DeviceManager } from "../../src/lib/deviceManager";

describe("DeviceManager", () => {
  let dm: DeviceManager;
  let mockRoom: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    dm = new DeviceManager();
    mockRoom = {
      localParticipant: {
        setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      },
      switchActiveDevice: vi.fn().mockResolvedValue(undefined),
    };

    // Stub navigator.mediaDevices
    vi.stubGlobal("navigator", {
      mediaDevices: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    dm.setRoom(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------
  // setRoom
  // -----------------------------------------------------------------------

  describe("setRoom", () => {
    it("accepts null and does not register a device change listener", () => {
      dm.setRoom(null);
      expect(navigator.mediaDevices.addEventListener).not.toHaveBeenCalled();
    });

    it("starts device change listener when room is set", () => {
      dm.setRoom(mockRoom);
      expect(navigator.mediaDevices.addEventListener).toHaveBeenCalledWith(
        "devicechange",
        expect.any(Function),
      );
    });

    it("stops device change listener when room is set to null", () => {
      dm.setRoom(mockRoom);
      dm.setRoom(null);
      expect(navigator.mediaDevices.removeEventListener).toHaveBeenCalledWith(
        "devicechange",
        expect.any(Function),
      );
    });

    it("stops old listener before starting new one when room changes", () => {
      dm.setRoom(mockRoom);
      const firstHandler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      dm.setRoom(mockRoom);
      expect(navigator.mediaDevices.removeEventListener).toHaveBeenCalledWith(
        "devicechange",
        firstHandler,
      );
    });
  });

  // -----------------------------------------------------------------------
  // setAudioPipeline, setOnError, setOnToast
  // -----------------------------------------------------------------------

  describe("setAudioPipeline", () => {
    it("clears the pipeline so device switches skip pipeline setup", async () => {
      const pipeline = {
        setupAudioPipeline: vi.fn(),
        applyNoiseSuppressor: vi.fn(),
        removeNoiseSuppressor: vi.fn(),
      } as any;
      dm.setAudioPipeline(pipeline);
      dm.setAudioPipeline(null);
      // Verify pipeline methods are NOT called on a subsequent device switch
      dm.setRoom(mockRoom);
      await dm.switchInputDevice("device-1");
      expect(pipeline.setupAudioPipeline).not.toHaveBeenCalled();
    });

    it("stores a pipeline that is invoked during device switches", async () => {
      const pipeline = {
        setupAudioPipeline: vi.fn(),
        applyNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
        removeNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
      } as any;
      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      await dm.switchInputDevice("device-1");
      expect(pipeline.setupAudioPipeline).toHaveBeenCalled();
    });
  });

  describe("setOnError", () => {
    it("clears the error callback so device switch errors are suppressed", async () => {
      const onError = vi.fn();
      dm.setOnError(onError);
      dm.setOnError(null);
      dm.setRoom(mockRoom);
      mockRoom.switchActiveDevice.mockRejectedValue(new Error("device error"));
      await dm.switchInputDevice("device-1");
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("setOnToast", () => {
    it("clears the toast callback so device switch toasts are suppressed", async () => {
      const onToast = vi.fn();
      const pipeline = {
        setupAudioPipeline: vi.fn(() => {
          throw new Error("pipeline error");
        }),
        applyNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
        removeNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
      } as any;
      dm.setOnToast(onToast);
      dm.setOnToast(null);
      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      await dm.switchInputDevice("device-1");
      expect(onToast).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // switchInputDevice
  // -----------------------------------------------------------------------

  describe("switchInputDevice", () => {
    it("does nothing when no room is set", async () => {
      await dm.switchInputDevice("device-1");
      expect(mockRoom.switchActiveDevice).not.toHaveBeenCalled();
    });

    it("calls room.switchActiveDevice for non-empty deviceId", async () => {
      dm.setRoom(mockRoom);
      await dm.switchInputDevice("device-1");
      expect(mockRoom.switchActiveDevice).toHaveBeenCalledWith("audioinput", "device-1");
    });

    it("re-enables microphone for empty deviceId (default fallback)", async () => {
      dm.setRoom(mockRoom);
      await dm.switchInputDevice("");
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    });

    it("calls setupAudioPipeline on the pipeline after switch", async () => {
      const pipeline = {
        setupAudioPipeline: vi.fn(),
        applyNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
        removeNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
      } as any;
      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      await dm.switchInputDevice("device-1");
      expect(pipeline.setupAudioPipeline).toHaveBeenCalled();
    });

    it("applies enhanced noise suppression when enabled", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "enhancedNoiseSuppression") return true;
        return defaultVal;
      });
      const pipeline = {
        setupAudioPipeline: vi.fn(),
        applyNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
        removeNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
      } as any;
      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      await dm.switchInputDevice("device-1");
      expect(pipeline.applyNoiseSuppressor).toHaveBeenCalled();
    });

    it("removes noise suppression when not enabled", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "enhancedNoiseSuppression") return false;
        return defaultVal;
      });
      const pipeline = {
        setupAudioPipeline: vi.fn(),
        applyNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
        removeNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
      } as any;
      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      await dm.switchInputDevice("device-1");
      expect(pipeline.removeNoiseSuppressor).toHaveBeenCalled();
    });

    it("calls onError callback on device switch failure", async () => {
      const onError = vi.fn();
      dm.setRoom(mockRoom);
      dm.setOnError(onError);
      mockRoom.switchActiveDevice.mockRejectedValue(new Error("device error"));
      await dm.switchInputDevice("device-1");
      expect(onError).toHaveBeenCalledWith("Failed to switch microphone");
    });

    it("shows toast when pipeline setup fails", async () => {
      const onToast = vi.fn();
      const pipeline = {
        setupAudioPipeline: vi.fn(() => {
          throw new Error("pipeline error");
        }),
        applyNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
        removeNoiseSuppressor: vi.fn().mockResolvedValue(undefined),
      } as any;
      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      dm.setOnToast(onToast);
      await dm.switchInputDevice("device-1");
      expect(onToast).toHaveBeenCalledWith("Audio pipeline error after device switch");
    });
  });

  // -----------------------------------------------------------------------
  // switchOutputDevice
  // -----------------------------------------------------------------------

  describe("switchOutputDevice", () => {
    it("skips device switch when no room is set", async () => {
      await dm.switchOutputDevice("device-1");
      expect(mockRoom.switchActiveDevice).not.toHaveBeenCalled();
    });

    it("calls room.switchActiveDevice for audiooutput", async () => {
      dm.setRoom(mockRoom);
      await dm.switchOutputDevice("device-1");
      expect(mockRoom.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "device-1");
    });
  });

  // -----------------------------------------------------------------------
  // Device change detection (hot-swap)
  // -----------------------------------------------------------------------

  describe("handleDeviceChange", () => {
    it("skips device enumeration when room is null at change time", async () => {
      dm.setRoom(mockRoom);
      // Capture the handler
      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      // Set room to null before triggering
      dm.setRoom(null);
      // Trigger the handler (simulates device change event)
      handler();
      await vi.advanceTimersByTimeAsync(600);
      // With room null, getLocalDevices should never be called
      expect(mockGetLocalDevices).not.toHaveBeenCalled();
      expect(mockRoom.switchActiveDevice).not.toHaveBeenCalled();
    });

    it("falls back to default input when saved device is removed", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "saved-device-id";
        if (key === "audioOutputDevice") return "";
        return defaultVal;
      });
      // The saved device is not in the returned list
      mockGetLocalDevices.mockImplementation((kind: string) => {
        if (kind === "audioinput") return Promise.resolve([{ deviceId: "other-device" }]);
        return Promise.resolve([]);
      });

      const onToast = vi.fn();
      dm.setRoom(mockRoom);
      dm.setOnToast(onToast);

      // Trigger device change
      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSavePref).toHaveBeenCalledWith("audioInputDevice", "");
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(onToast).toHaveBeenCalledWith("Audio device disconnected — switched to default");
    });

    it("does nothing if saved input device still exists", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "device-A";
        if (key === "audioOutputDevice") return "";
        return defaultVal;
      });
      mockGetLocalDevices.mockImplementation((kind: string) => {
        if (kind === "audioinput") return Promise.resolve([{ deviceId: "device-A" }]);
        return Promise.resolve([]);
      });

      dm.setRoom(mockRoom);
      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      // Should not reset the saved device
      expect(mockSavePref).not.toHaveBeenCalledWith("audioInputDevice", "");
    });

    it("does nothing if no saved device (empty string)", async () => {
      mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
      mockGetLocalDevices.mockResolvedValue([]);

      dm.setRoom(mockRoom);
      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSavePref).not.toHaveBeenCalledWith("audioInputDevice", "");
    });

    it("falls back to default output when saved output device is removed", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "";
        if (key === "audioOutputDevice") return "saved-output-id";
        return defaultVal;
      });
      mockGetLocalDevices.mockImplementation((kind: string) => {
        if (kind === "audioinput") return Promise.resolve([]);
        if (kind === "audiooutput") return Promise.resolve([{ deviceId: "other-output" }]);
        return Promise.resolve([]);
      });

      const onToast = vi.fn();
      dm.setRoom(mockRoom);
      dm.setOnToast(onToast);

      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSavePref).toHaveBeenCalledWith("audioOutputDevice", "");
      expect(onToast).toHaveBeenCalledWith(
        "Audio output device disconnected — switched to default",
      );
    });

    it("calls onError when mic fallback fails", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "saved-device-id";
        if (key === "audioOutputDevice") return "";
        return defaultVal;
      });
      mockGetLocalDevices.mockImplementation((kind: string) => {
        if (kind === "audioinput") return Promise.resolve([]);
        return Promise.resolve([]);
      });
      mockRoom.localParticipant.setMicrophoneEnabled.mockRejectedValue(new Error("no device"));

      const onError = vi.fn();
      dm.setRoom(mockRoom);
      dm.setOnError(onError);

      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      expect(onError).toHaveBeenCalledWith("No audio input device available");
    });

    it("debounces rapid device change events", async () => {
      mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
      mockGetLocalDevices.mockResolvedValue([]);

      dm.setRoom(mockRoom);
      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];

      // Fire multiple times in rapid succession
      handler();
      handler();
      handler();

      await vi.advanceTimersByTimeAsync(600);

      // handleDeviceChange calls getLocalDevices twice (audioinput + audiooutput)
      // but only ONE handleDeviceChange should run (debounced from 3 events)
      expect(mockGetLocalDevices).toHaveBeenCalledTimes(2);
      expect(mockGetLocalDevices).toHaveBeenCalledWith("audioinput");
      expect(mockGetLocalDevices).toHaveBeenCalledWith("audiooutput");
    });

    it("shows toast when pipeline setup fails during fallback", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioInputDevice") return "saved-device-id";
        if (key === "audioOutputDevice") return "";
        return defaultVal;
      });
      mockGetLocalDevices.mockImplementation((kind: string) => {
        if (kind === "audioinput") return Promise.resolve([]); // Device removed
        return Promise.resolve([]);
      });

      const pipeline = {
        setupAudioPipeline: vi.fn(() => {
          throw new Error("pipeline error");
        }),
      } as any;
      const onToast = vi.fn();

      dm.setRoom(mockRoom);
      dm.setAudioPipeline(pipeline);
      dm.setOnToast(onToast);

      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      expect(onToast).toHaveBeenCalledWith("Audio pipeline error after device switch");
    });

    it("handles enumerate devices failure without crashing or switching devices", async () => {
      mockGetLocalDevices.mockRejectedValue(new Error("enumerate error"));

      dm.setRoom(mockRoom);
      const handler = (navigator.mediaDevices.addEventListener as any).mock.calls[0][1];
      handler();
      await vi.advanceTimersByTimeAsync(600);

      // Enumerate failed, so no device switch should have been attempted
      expect(mockRoom.switchActiveDevice).not.toHaveBeenCalled();
    });
  });
});
