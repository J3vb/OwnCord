import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("@lib/noise-suppression", () => ({
  createRNNoiseProcessor: vi.fn(),
}));

vi.mock("livekit-client", () => ({
  Track: {
    Source: {
      Microphone: "microphone",
      Camera: "camera",
      ScreenShare: "screenShare",
      ScreenShareAudio: "screenShareAudio",
    },
  },
}));

import { AudioPipeline } from "../../src/lib/audioPipeline";

describe("AudioPipeline", () => {
  let pipeline: AudioPipeline;

  beforeEach(() => {
    vi.clearAllMocks();
    pipeline = new AudioPipeline();
  });

  describe("initial state", () => {
    it("is not active by default", () => {
      expect(pipeline.isActive).toBe(false);
    });

    it("has null gainValue when inactive", () => {
      expect(pipeline.gainValue).toBeNull();
    });

    it("has null ctxState when inactive", () => {
      expect(pipeline.ctxState).toBeNull();
    });

    it("is not VAD gated by default", () => {
      expect(pipeline.isVadGated).toBe(false);
    });

    it("has default input gain of 1.0", () => {
      expect(pipeline.inputGain).toBe(1.0);
    });

    it("has zero lastVadRms by default", () => {
      expect(pipeline.lastVadRms).toBe(0);
    });

    it("is not using worklet by default", () => {
      expect(pipeline.vadUsingWorklet).toBe(false);
    });
  });

  describe("setRoom", () => {
    it("accepts null without throwing", () => {
      expect(() => pipeline.setRoom(null)).not.toThrow();
    });

    it("accepts a room-like object", () => {
      const mockRoom = { localParticipant: {} } as any;
      expect(() => pipeline.setRoom(mockRoom)).not.toThrow();
    });
  });

  describe("setInputVolume", () => {
    it("saves clamped volume to preferences", () => {
      pipeline.setInputVolume(75);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 75);
    });

    it("clamps to 0-200 range", () => {
      pipeline.setInputVolume(-10);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 0);
      expect(pipeline.inputGain).toBe(0);

      pipeline.setInputVolume(250);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 200);
      expect(pipeline.inputGain).toBe(2.0);
    });

    it("updates inputGain property", () => {
      pipeline.setInputVolume(150);
      expect(pipeline.inputGain).toBe(1.5);
    });
  });

  describe("setVoiceSensitivity", () => {
    it("saves clamped sensitivity to preferences", () => {
      pipeline.setVoiceSensitivity(50);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 50);
    });

    it("clamps to 0-100 range", () => {
      pipeline.setVoiceSensitivity(-5);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 0);

      pipeline.setVoiceSensitivity(150);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 100);
    });

    it("does not throw when no pipeline is active", () => {
      expect(() => pipeline.setVoiceSensitivity(50)).not.toThrow();
    });
  });

  describe("setupAudioPipeline", () => {
    it("does nothing when no room is set", () => {
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
    });

    it("does nothing when room has no mic track", () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue(undefined),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
    });
  });

  describe("teardownAudioPipeline", () => {
    it("does not throw when no pipeline exists", () => {
      expect(() => pipeline.teardownAudioPipeline()).not.toThrow();
    });

    it("resets VAD gated state", () => {
      // Force vadGated to true via internal state
      (pipeline as any).vadGated = true;
      pipeline.teardownAudioPipeline();
      expect(pipeline.isVadGated).toBe(false);
    });
  });

  describe("updatePipelineGain", () => {
    it("does not throw when no pipeline exists", () => {
      expect(() => pipeline.updatePipelineGain()).not.toThrow();
    });
  });

  describe("startVadPolling", () => {
    it("does not throw when no pipeline exists", () => {
      expect(() => pipeline.startVadPolling()).not.toThrow();
    });
  });

  describe("stopVadPolling", () => {
    it("does not throw when no VAD is running", () => {
      expect(() => pipeline.stopVadPolling()).not.toThrow();
    });

    it("resets lastVadRms to 0", () => {
      (pipeline as any)._lastVadRms = 0.5;
      pipeline.stopVadPolling();
      expect(pipeline.lastVadRms).toBe(0);
    });

    it("ungates if was gated", () => {
      (pipeline as any).vadGated = true;
      pipeline.stopVadPolling();
      expect(pipeline.isVadGated).toBe(false);
    });
  });

  describe("applyNoiseSuppressor", () => {
    it("does nothing when no room is set", async () => {
      await expect(pipeline.applyNoiseSuppressor()).resolves.toBeUndefined();
    });

    it("does nothing when no mic track exists", async () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue(undefined),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await expect(pipeline.applyNoiseSuppressor()).resolves.toBeUndefined();
    });
  });

  describe("removeNoiseSuppressor", () => {
    it("does nothing when no room is set", async () => {
      await expect(pipeline.removeNoiseSuppressor()).resolves.toBeUndefined();
    });
  });

  describe("reapplyAudioProcessing", () => {
    it("does nothing when no room is set", async () => {
      await expect(pipeline.reapplyAudioProcessing()).resolves.toBeUndefined();
    });

    it("does nothing when room has no mic track", async () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue(undefined),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await expect(pipeline.reapplyAudioProcessing()).resolves.toBeUndefined();
    });

    it("calls onError callback on failure", async () => {
      const onError = vi.fn();
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              restartTrack: vi.fn().mockRejectedValue(new Error("device error")),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await pipeline.reapplyAudioProcessing(onError);
      expect(onError).toHaveBeenCalledWith("Failed to update audio settings");
    });
  });
});
