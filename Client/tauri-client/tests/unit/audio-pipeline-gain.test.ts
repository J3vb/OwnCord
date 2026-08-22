import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

    it("persists sensitivity value even when no pipeline is active", () => {
      pipeline.setVoiceSensitivity(50);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 50);
      // Pipeline is not active so VAD gating remains off
      expect(pipeline.isVadGated).toBe(false);
      expect(pipeline.isActive).toBe(false);
    });
  });

  describe("updatePipelineGain", () => {
    it("leaves gainValue null when no pipeline exists", () => {
      pipeline.updatePipelineGain();
      expect(pipeline.gainValue).toBeNull();
    });
  });

  describe("setVoiceSensitivity edge cases", () => {
    it("sensitivity 100 ungates if previously gated", () => {
      (pipeline as any).vadGated = true;
      pipeline.setVoiceSensitivity(100);
      expect(pipeline.isVadGated).toBe(false);
    });

    it("sensitivity below 100 does not change gated state without active pipeline", () => {
      pipeline.setVoiceSensitivity(50);
      // No crash, no active pipeline to start VAD on
      expect(pipeline.isVadGated).toBe(false);
    });
  });

  describe("setInputVolume boundary and arithmetic precision", () => {
    it("volume 0 produces inputGain exactly 0", () => {
      pipeline.setInputVolume(0);
      expect(pipeline.inputGain).toBe(0);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 0);
    });

    it("volume 200 produces inputGain exactly 2.0", () => {
      pipeline.setInputVolume(200);
      expect(pipeline.inputGain).toBe(2.0);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 200);
    });

    it("volume 100 produces inputGain exactly 1.0", () => {
      pipeline.setInputVolume(100);
      expect(pipeline.inputGain).toBe(1.0);
    });

    it("volume 1 produces inputGain 0.01", () => {
      pipeline.setInputVolume(1);
      expect(pipeline.inputGain).toBeCloseTo(0.01, 5);
    });

    it("negative volume clamps to 0 (not negative)", () => {
      pipeline.setInputVolume(-100);
      expect(pipeline.inputGain).toBe(0);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 0);
    });

    it("volume above 200 clamps to 200 (not raw value)", () => {
      pipeline.setInputVolume(500);
      expect(pipeline.inputGain).toBe(2.0);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 200);
    });

    it("volume exactly at lower boundary (0) is saved as 0, not clamped further", () => {
      pipeline.setInputVolume(0);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 0);
    });

    it("volume exactly at upper boundary (200) is saved as 200, not clamped further", () => {
      pipeline.setInputVolume(200);
      expect(mockSavePref).toHaveBeenCalledWith("inputVolume", 200);
    });
  });

  describe("setVoiceSensitivity boundary and arithmetic precision", () => {
    it("sensitivity 0 clamps to 0 and saves", () => {
      pipeline.setVoiceSensitivity(0);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 0);
    });

    it("sensitivity exactly 100 saves 100", () => {
      pipeline.setVoiceSensitivity(100);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 100);
    });

    it("sensitivity exactly 99 saves 99 (below 100 threshold)", () => {
      pipeline.setVoiceSensitivity(99);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 99);
    });

    it("sensitivity above 100 clamps to 100", () => {
      pipeline.setVoiceSensitivity(200);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 100);
    });

    it("sensitivity below 0 clamps to 0", () => {
      pipeline.setVoiceSensitivity(-50);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 0);
    });

    it("sensitivity 100 does NOT ungate when already ungated", () => {
      // vadGated is false by default; sensitivity 100 should not crash or change state
      expect(pipeline.isVadGated).toBe(false);
      pipeline.setVoiceSensitivity(100);
      expect(pipeline.isVadGated).toBe(false);
    });

    it("sensitivity < 100 calls stopVadPolling which ungates, then restarts polling", () => {
      (pipeline as any).vadGated = true;
      // setVoiceSensitivity calls stopVadPolling() first, which ungates
      pipeline.setVoiceSensitivity(99);
      // stopVadPolling always ungates if gated
      expect(pipeline.isVadGated).toBe(false);
    });

    it("sensitivity >= 100 ungates immediately without starting VAD", () => {
      (pipeline as any).vadGated = true;
      pipeline.setVoiceSensitivity(100);
      expect(pipeline.isVadGated).toBe(false);
    });
  });

  describe("updatePipelineGain effective gain logic", () => {
    let mockGainNode: any;
    let mockAudioCtx: any;

    beforeEach(() => {
      mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      mockAudioCtx = {
        currentTime: 0.5,
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue({
          fftSize: 0,
          smoothingTimeConstant: 0,
          connect: vi.fn(),
          disconnect: vi.fn(),
          getFloatTimeDomainData: vi.fn(),
        }),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal(
        "AudioContext",
        vi.fn(function () {
          return mockAudioCtx;
        }),
      );
      vi.stubGlobal(
        "MediaStream",
        vi.fn(function () {
          return {};
        }),
      );
    });

    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("uses setTargetAtTime with smoothing constant 0.015", () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "t" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      mockGainNode.gain.setTargetAtTime.mockClear();

      pipeline.setInputVolume(80);
      const lastCall =
        mockGainNode.gain.setTargetAtTime.mock.calls[
          mockGainNode.gain.setTargetAtTime.mock.calls.length - 1
        ];
      expect(lastCall[2]).toBe(0.015); // smoothing time constant
    });

    it("uses ctx.currentTime as the start time for setTargetAtTime", () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "t" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      mockGainNode.gain.setTargetAtTime.mockClear();

      pipeline.setInputVolume(60);
      const lastCall =
        mockGainNode.gain.setTargetAtTime.mock.calls[
          mockGainNode.gain.setTargetAtTime.mock.calls.length - 1
        ];
      expect(lastCall[1]).toBe(0.5); // ctx.currentTime
    });

    it("gain is currentInputGain when not vadGated", () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "t" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      pipeline.setInputVolume(130);
      mockGainNode.gain.setTargetAtTime.mockClear();

      pipeline.updatePipelineGain();
      const lastCall = mockGainNode.gain.setTargetAtTime.mock.calls[0];
      expect(lastCall[0]).toBe(1.3); // 130 / 100
    });

    it("gain is exactly 0 when vadGated, regardless of inputGain", () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "t" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      pipeline.setInputVolume(200);
      (pipeline as any).vadGated = true;
      mockGainNode.gain.setTargetAtTime.mockClear();

      pipeline.updatePipelineGain();
      const lastCall = mockGainNode.gain.setTargetAtTime.mock.calls[0];
      expect(lastCall[0]).toBe(0);
    });

    it("does nothing when audioPipelineGain is null but ctx is not", () => {
      // Set pipeline state to have ctx but no gain — simulates partial teardown
      (pipeline as any).audioPipelineCtx = mockAudioCtx;
      (pipeline as any).audioPipelineGain = null;
      mockGainNode.gain.setTargetAtTime.mockClear();
      pipeline.updatePipelineGain();
      expect(mockGainNode.gain.setTargetAtTime).not.toHaveBeenCalled();
    });

    it("does nothing when audioPipelineCtx is null but gain is not", () => {
      (pipeline as any).audioPipelineGain = mockGainNode;
      (pipeline as any).audioPipelineCtx = null;
      mockGainNode.gain.setTargetAtTime.mockClear();
      pipeline.updatePipelineGain();
      expect(mockGainNode.gain.setTargetAtTime).not.toHaveBeenCalled();
    });
  });

  describe("setInputVolume calls updatePipelineGain", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("calls updatePipelineGain which is no-op without active pipeline", () => {
      // No active pipeline — updatePipelineGain should not throw
      pipeline.setInputVolume(50);
      expect(pipeline.inputGain).toBe(0.5);
      expect(pipeline.gainValue).toBeNull(); // no pipeline
    });
  });
});
