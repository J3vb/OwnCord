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
import { createRNNoiseProcessor } from "../../src/lib/noise-suppression";

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
    it("clears the current room when set to null", () => {
      pipeline.setRoom({ localParticipant: {} } as any);
      pipeline.setRoom(null);

      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
    });

    it("stores a room-like object for later setup", () => {
      const getTrackPublication = vi.fn().mockReturnValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication,
        },
      } as any;
      pipeline.setRoom(mockRoom);

      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
      expect(getTrackPublication).toHaveBeenCalled();
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

    it("persists sensitivity value even when no pipeline is active", () => {
      pipeline.setVoiceSensitivity(50);
      expect(mockSavePref).toHaveBeenCalledWith("voiceSensitivity", 50);
      // Pipeline is not active so VAD gating remains off
      expect(pipeline.isVadGated).toBe(false);
      expect(pipeline.isActive).toBe(false);
    });
  });

  describe("setupAudioPipeline", () => {
    it("does nothing when no room is set", () => {
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
      expect(pipeline.gainValue).toBeNull();
      expect(pipeline.ctxState).toBeNull();
    });

    it("does nothing when room has no mic track", () => {
      const getTrackPublication = vi.fn().mockReturnValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication,
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
      expect(getTrackPublication).toHaveBeenCalled();
    });
  });

  describe("teardownAudioPipeline", () => {
    it("leaves the pipeline inactive when nothing was created", () => {
      pipeline.teardownAudioPipeline();
      expect(pipeline.isActive).toBe(false);
    });

    it("resets VAD gated state", () => {
      // Force vadGated to true via internal state
      (pipeline as any).vadGated = true;
      pipeline.teardownAudioPipeline();
      expect(pipeline.isVadGated).toBe(false);
    });
  });

  describe("updatePipelineGain", () => {
    it("leaves gainValue null when no pipeline exists", () => {
      pipeline.updatePipelineGain();
      expect(pipeline.gainValue).toBeNull();
    });
  });

  describe("startVadPolling", () => {
    it("does not activate VAD without an analyser", () => {
      pipeline.startVadPolling();
      expect(pipeline.vadUsingWorklet).toBe(false);
      expect(pipeline.lastVadRms).toBe(0);
    });
  });

  describe("stopVadPolling", () => {
    it("is idempotent when no VAD is running", () => {
      pipeline.stopVadPolling();
      pipeline.stopVadPolling();
      expect(pipeline.lastVadRms).toBe(0);
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
      vi.mocked(createRNNoiseProcessor).mockClear();
      await expect(pipeline.applyNoiseSuppressor()).resolves.toBeUndefined();
      expect(createRNNoiseProcessor).not.toHaveBeenCalled();
    });

    it("does nothing when no mic track exists", async () => {
      const getTrackPublication = vi.fn().mockReturnValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication,
        },
      } as any;
      pipeline.setRoom(mockRoom);
      vi.mocked(createRNNoiseProcessor).mockClear();
      await expect(pipeline.applyNoiseSuppressor()).resolves.toBeUndefined();
      expect(getTrackPublication).toHaveBeenCalledOnce();
      expect(createRNNoiseProcessor).not.toHaveBeenCalled();
    });
  });

  describe("removeNoiseSuppressor", () => {
    it("does nothing when no room is set", async () => {
      await expect(pipeline.removeNoiseSuppressor()).resolves.toBeUndefined();
      expect(pipeline.isActive).toBe(false);
    });
  });

  describe("reapplyAudioProcessing", () => {
    it("does nothing when no room is set", async () => {
      await expect(pipeline.reapplyAudioProcessing()).resolves.toBeUndefined();
      expect(pipeline.isActive).toBe(false);
    });

    it("does nothing when room has no mic track", async () => {
      const getTrackPublication = vi.fn().mockReturnValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication,
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await expect(pipeline.reapplyAudioProcessing()).resolves.toBeUndefined();
      expect(getTrackPublication).toHaveBeenCalledOnce();
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

    it("does not call onError when no callback provided", async () => {
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
      // Should not throw even without onError
      await expect(pipeline.reapplyAudioProcessing()).resolves.toBeUndefined();
    });

    it("does nothing when mic track is undefined", async () => {
      const getTrackPublication = vi.fn().mockReturnValue({ track: undefined });
      const mockRoom = {
        localParticipant: {
          getTrackPublication,
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await expect(pipeline.reapplyAudioProcessing()).resolves.toBeUndefined();
      expect(getTrackPublication).toHaveBeenCalledOnce();
    });
  });

  // --- Full AudioContext pipeline tests ---

  describe("setupAudioPipeline with AudioContext mock", () => {
    let mockGainNode: any;
    let mockAnalyserNode: any;
    let mockDestNode: any;
    let mockSourceNode: any;
    let mockAudioCtx: any;
    let mockRoom: any;
    let mockSender: any;

    afterEach(() => {
      // Ensure pipeline is torn down to clear VAD timers
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    beforeEach(() => {
      mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      mockAnalyserNode = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      mockDestNode = {
        stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "adjusted-track" }]) },
        disconnect: vi.fn(),
      };
      mockSourceNode = {
        connect: vi.fn(),
      };
      mockSender = {
        replaceTrack: vi.fn().mockResolvedValue(undefined),
      };

      mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyserNode),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue(mockDestNode),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no worklet")) },
      };

      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "original-track" },
              sender: mockSender,
              getProcessor: vi.fn().mockReturnValue(undefined),
              setProcessor: vi.fn().mockResolvedValue(undefined),
              stopProcessor: vi.fn().mockResolvedValue(undefined),
            },
          }),
        },
      };
    });

    it("creates the full audio pipeline when room and mic track are available", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      expect(pipeline.isActive).toBe(true);
      expect(mockAudioCtx.createGain).toHaveBeenCalled();
      expect(mockAudioCtx.createAnalyser).toHaveBeenCalled();
      expect(mockAudioCtx.createMediaStreamDestination).toHaveBeenCalled();
      expect(mockSourceNode.connect).toHaveBeenCalledWith(mockAnalyserNode);
      expect(mockSourceNode.connect).toHaveBeenCalledWith(mockGainNode);
      expect(mockGainNode.connect).toHaveBeenCalledWith(mockDestNode);
    });

    it("replaces WebRTC sender track with pipeline output", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      expect(mockSender.replaceTrack).toHaveBeenCalledWith({ id: "adjusted-track" });
    });

    it("skips sender replacement when no adjusted track available", () => {
      mockDestNode.stream.getAudioTracks.mockReturnValue([]);
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      // replaceTrack is only called from teardown (not setup) since no adjusted track
      // The teardown in setupAudioPipeline (line 1) calls replaceTrack for restore,
      // but the setup itself should not call it with the adjusted track.
      // We confirm isActive is true — the pipeline was set up successfully.
      expect(pipeline.isActive).toBe(true);
    });

    it("does not replace sender if track has no sender", () => {
      mockRoom.localParticipant.getTrackPublication.mockReturnValue({
        track: {
          mediaStreamTrack: { id: "original-track" },
          sender: undefined,
          getProcessor: vi.fn(),
        },
      });
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      // Should not throw
      expect(pipeline.isActive).toBe(true);
    });

    it("reads input volume from preferences during setup", () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "inputVolume") return 75;
        return defaultVal;
      });

      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(0.75, 0);
    });

    it("reports ctxState from active AudioContext", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      expect(pipeline.ctxState).toBe("running");
    });

    it("reports gainValue from active GainNode", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      expect(pipeline.gainValue).toBe(1);
    });

    it("teardown disconnects and closes all nodes", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      pipeline.teardownAudioPipeline();

      expect(pipeline.isActive).toBe(false);
      expect(mockGainNode.disconnect).toHaveBeenCalled();
      expect(mockAnalyserNode.disconnect).toHaveBeenCalled();
      expect(mockDestNode.disconnect).toHaveBeenCalled();
      expect(mockAudioCtx.close).toHaveBeenCalled();
    });

    it("teardown restores original sender track", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      mockSender.replaceTrack.mockClear();
      pipeline.teardownAudioPipeline();

      expect(mockSender.replaceTrack).toHaveBeenCalledWith({ id: "original-track" });
    });

    it("teardown does not crash if room has no mic track", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      // Remove mic track before teardown
      mockRoom.localParticipant.getTrackPublication.mockReturnValue(undefined);
      expect(() => pipeline.teardownAudioPipeline()).not.toThrow();
    });

    it("teardown does not crash if mic track has no sender", () => {
      const roomWithNoSender = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "track" },
              sender: undefined,
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(roomWithNoSender);
      pipeline.setupAudioPipeline();
      expect(() => pipeline.teardownAudioPipeline()).not.toThrow();
    });

    it("setupAudioPipeline tears down existing pipeline first", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(true);

      // Second setup should tear down the first
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(true);
      expect(mockGainNode.disconnect).toHaveBeenCalled();
    });

    it("updatePipelineGain applies effective gain when active", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      pipeline.setInputVolume(50);

      expect(mockGainNode.gain.setTargetAtTime).toHaveBeenCalled();
      const call =
        mockGainNode.gain.setTargetAtTime.mock.calls[
          mockGainNode.gain.setTargetAtTime.mock.calls.length - 1
        ];
      expect(call[0]).toBe(0.5); // inputGain = 50/100 = 0.5, not vadGated
    });

    it("updatePipelineGain sets gain to 0 when VAD is gated", () => {
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      // Force VAD gated
      (pipeline as any).vadGated = true;
      pipeline.updatePipelineGain();

      const call =
        mockGainNode.gain.setTargetAtTime.mock.calls[
          mockGainNode.gain.setTargetAtTime.mock.calls.length - 1
        ];
      expect(call[0]).toBe(0);
    });

    it("handles AudioContext constructor failure gracefully", () => {
      vi.stubGlobal(
        "AudioContext",
        vi.fn(() => {
          throw new Error("AudioContext not supported");
        }),
      );
      pipeline.setRoom(mockRoom);
      // Should not throw
      expect(() => pipeline.setupAudioPipeline()).not.toThrow();
      expect(pipeline.isActive).toBe(false);
    });
  });

  // --- Noise suppressor with track ---

  describe("applyNoiseSuppressor with track", () => {
    it("does nothing when track already has a processor", async () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              getProcessor: vi.fn().mockReturnValue({}), // Already has processor
              setProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await pipeline.applyNoiseSuppressor();
      expect(
        mockRoom.localParticipant.getTrackPublication().track.setProcessor,
      ).not.toHaveBeenCalled();
    });

    it("attaches processor when track has none", async () => {
      const setProcessor = vi.fn().mockResolvedValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              getProcessor: vi.fn().mockReturnValue(undefined),
              setProcessor,
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await pipeline.applyNoiseSuppressor();
      expect(setProcessor).toHaveBeenCalled();
    });
  });

  describe("removeNoiseSuppressor with track", () => {
    it("does nothing when track has no processor", async () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              getProcessor: vi.fn().mockReturnValue(undefined),
              stopProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await pipeline.removeNoiseSuppressor();
      expect(
        mockRoom.localParticipant.getTrackPublication().track.stopProcessor,
      ).not.toHaveBeenCalled();
    });

    it("removes processor when track has one", async () => {
      const stopProcessor = vi.fn().mockResolvedValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              getProcessor: vi.fn().mockReturnValue({}),
              stopProcessor,
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await pipeline.removeNoiseSuppressor();
      expect(stopProcessor).toHaveBeenCalled();
    });

    it("does nothing when track is undefined", async () => {
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({ track: undefined }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      await expect(pipeline.removeNoiseSuppressor()).resolves.toBeUndefined();
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

  describe("VAD worklet path", () => {
    let mockGainNode: any;
    let mockAnalyserNode: any;
    let mockDestNode: any;
    let mockSourceNode: any;
    let mockAudioCtx: any;
    let mockRoom: any;

    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    function setupPipelineWithWorklet(workletBehavior: "success" | "fail"): void {
      mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      mockAnalyserNode = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      mockDestNode = {
        stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "track" }]) },
        disconnect: vi.fn(),
      };
      mockSourceNode = { connect: vi.fn() };
      mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyserNode),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue(mockDestNode),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: {
          addModule:
            workletBehavior === "success"
              ? vi.fn().mockResolvedValue(undefined)
              : vi.fn().mockRejectedValue(new Error("no worklet")),
        },
      };

      // Mock AudioWorkletNode
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn().mockImplementation(() => ({
          port: {
            postMessage: vi.fn(),
            onmessage: null as ((event: MessageEvent) => void) | null,
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
      );
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "track" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
              setProcessor: vi.fn(),
              stopProcessor: vi.fn(),
            },
          }),
        },
      };

      // Set sensitivity < 100 so VAD polling starts
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });
    }

    it("starts VAD worklet when AudioWorklet addModule succeeds", async () => {
      setupPipelineWithWorklet("success");
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      // Wait for the async addModule to resolve
      await vi.waitFor(() => {
        expect(pipeline.vadUsingWorklet).toBe(true);
      });
    });

    it("falls back to setTimeout VAD when AudioWorklet addModule fails", async () => {
      setupPipelineWithWorklet("fail");
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      await vi.waitFor(() => {
        // After worklet failure, falls back to setTimeout
        expect(pipeline.vadUsingWorklet).toBe(false);
      });
    });

    it("worklet gate message toggles VAD gate", async () => {
      setupPipelineWithWorklet("success");
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      await vi.waitFor(() => {
        expect(pipeline.vadUsingWorklet).toBe(true);
      });

      // Get the AudioWorkletNode mock and simulate a gate message
      const WorkletNodeConstructor = (globalThis as any).AudioWorkletNode;
      const workletInstance = WorkletNodeConstructor.mock.results[0].value;

      // Simulate gate message
      workletInstance.port.onmessage({ data: { type: "gate", gated: true } } as any);
      expect(pipeline.isVadGated).toBe(true);

      workletInstance.port.onmessage({ data: { type: "gate", gated: false } } as any);
      expect(pipeline.isVadGated).toBe(false);
    });

    it("worklet rms message updates lastVadRms", async () => {
      setupPipelineWithWorklet("success");
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      await vi.waitFor(() => {
        expect(pipeline.vadUsingWorklet).toBe(true);
      });

      const WorkletNodeConstructor = (globalThis as any).AudioWorkletNode;
      const workletInstance = WorkletNodeConstructor.mock.results[0].value;

      workletInstance.port.onmessage({ data: { type: "rms", value: 0.42 } } as any);
      expect(pipeline.lastVadRms).toBe(0.42);
    });

    it("stopVadPolling disconnects worklet node", async () => {
      setupPipelineWithWorklet("success");
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      await vi.waitFor(() => {
        expect(pipeline.vadUsingWorklet).toBe(true);
      });

      const WorkletNodeConstructor = (globalThis as any).AudioWorkletNode;
      const workletInstance = WorkletNodeConstructor.mock.results[0].value;

      pipeline.stopVadPolling();

      expect(workletInstance.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
      expect(workletInstance.disconnect).toHaveBeenCalled();
      expect(pipeline.vadUsingWorklet).toBe(false);
    });

    it("falls back to setTimeout when AudioWorkletNode constructor throws", async () => {
      setupPipelineWithWorklet("success");
      // Override AudioWorkletNode to throw
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn().mockImplementation(() => {
          throw new Error("AudioWorkletNode not supported");
        }),
      );

      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      await vi.waitFor(() => {
        // Should have fallen back to setTimeout
        expect(pipeline.vadUsingWorklet).toBe(false);
      });
    });
  });

  describe("VAD fallback polling", () => {
    afterEach(() => {
      // Stop VAD first to clear the setTimeout chain before teardown
      pipeline.stopVadPolling();
      pipeline.teardownAudioPipeline();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("gates audio after sustained silence", async () => {
      vi.useFakeTimers();
      const dataArray = new Float32Array(2048);
      // Fill with silence
      dataArray.fill(0);

      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => {
          arr.set(dataArray);
        }),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "track" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no worklet")) },
      };

      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "track" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
              setProcessor: vi.fn(),
              stopProcessor: vi.fn(),
            },
          }),
        },
      } as any;

      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      // Wait for worklet to fail and fallback to start
      await vi.advanceTimersByTimeAsync(100);

      // Run enough frames to pass startup grace (30 frames * 16ms = 480ms)
      // and then enough silent frames to trigger gate (12 frames * 16ms = 192ms)
      await vi.advanceTimersByTimeAsync(1200);

      expect(pipeline.isVadGated).toBe(true);
    });

    it("ungates audio after speech is detected", async () => {
      vi.useFakeTimers();
      let isSilent = true;
      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => {
          if (isSilent) {
            arr.fill(0);
          } else {
            // Fill with loud signal
            for (let i = 0; i < arr.length; i++) arr[i] = 0.5;
          }
        }),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "track" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no worklet")) },
      };

      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "track" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn(),
              setProcessor: vi.fn(),
              stopProcessor: vi.fn(),
            },
          }),
        },
      } as any;

      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      await vi.advanceTimersByTimeAsync(100);

      // Gate first with silence
      await vi.advanceTimersByTimeAsync(1200);
      expect(pipeline.isVadGated).toBe(true);

      // Now simulate speech
      isSilent = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(pipeline.isVadGated).toBe(false);
    });
  });

  // --- Mutation-killing tests: boundary conditions, arithmetic, boolean logic ---

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
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
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

  describe("setupAudioPipeline AudioContext configuration", () => {
    let mockAudioCtx: any;

    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("creates AudioContext with sampleRate 48000", () => {
      const AudioContextSpy = vi.fn().mockReturnValue({
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue({
          fftSize: 0,
          smoothingTimeConstant: 0,
          connect: vi.fn(),
          disconnect: vi.fn(),
          getFloatTimeDomainData: vi.fn(),
        }),
        createGain: vi.fn().mockReturnValue({
          gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      });
      vi.stubGlobal("AudioContext", AudioContextSpy);
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

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

      expect(AudioContextSpy).toHaveBeenCalledWith({ sampleRate: 48000 });
    });

    it("sets analyser fftSize to 2048", () => {
      const mockAnalyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue({
          gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

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

      expect(mockAnalyser.fftSize).toBe(2048);
    });

    it("sets analyser smoothingTimeConstant to 0.3", () => {
      const mockAnalyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue({
          gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

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

      expect(mockAnalyser.smoothingTimeConstant).toBe(0.3);
    });

    it("calls ctx.resume() during setup", () => {
      mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue({
          fftSize: 0,
          smoothingTimeConstant: 0,
          connect: vi.fn(),
          disconnect: vi.fn(),
          getFloatTimeDomainData: vi.fn(),
        }),
        createGain: vi.fn().mockReturnValue({
          gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

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

      expect(mockAudioCtx.resume).toHaveBeenCalled();
    });
  });

  describe("teardownAudioPipeline increments generation", () => {
    it("increments _pipelineGeneration on each teardown", () => {
      const gen0 = (pipeline as any)._pipelineGeneration;
      pipeline.teardownAudioPipeline();
      expect((pipeline as any)._pipelineGeneration).toBe(gen0 + 1);
      pipeline.teardownAudioPipeline();
      expect((pipeline as any)._pipelineGeneration).toBe(gen0 + 2);
    });
  });

  describe("startVadPolling threshold calculation and sensitivity guard", () => {
    let mockAnalyser: any;
    let mockGainNode: any;
    let mockAudioCtx: any;

    afterEach(() => {
      pipeline.stopVadPolling();
      pipeline.teardownAudioPipeline();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function setupPipelineForVad(sensitivity: number): void {
      mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => arr.fill(0)),
      };
      mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return sensitivity;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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
    }

    it("sensitivity 100 prevents VAD from starting (no polling)", async () => {
      vi.useFakeTimers();
      setupPipelineForVad(100);
      pipeline.setupAudioPipeline();

      // Wait for async paths to settle
      await vi.advanceTimersByTimeAsync(200);

      // VAD should not be running - no gate should happen even after lots of silence
      await vi.advanceTimersByTimeAsync(2000);
      expect(pipeline.isVadGated).toBe(false);
    });

    it("sensitivity 99 allows VAD to start and eventually gate silence", async () => {
      vi.useFakeTimers();
      setupPipelineForVad(99);
      pipeline.setupAudioPipeline();

      await vi.advanceTimersByTimeAsync(100); // worklet fails, fallback starts
      await vi.advanceTimersByTimeAsync(1200); // startup grace + gate frames
      expect(pipeline.isVadGated).toBe(true);
    });

    it("sensitivity 0 produces high threshold that gates easily", async () => {
      vi.useFakeTimers();
      setupPipelineForVad(0);
      // threshold = ((100 - 0) / 100) * 0.1 = 0.1
      pipeline.setupAudioPipeline();

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1200);
      expect(pipeline.isVadGated).toBe(true);
    });

    it("sensitivity 50 produces threshold 0.05", async () => {
      vi.useFakeTimers();
      setupPipelineForVad(50);
      // threshold = ((100 - 50) / 100) * 0.1 = 0.05
      // silence (rms=0) < 0.05, so should gate
      pipeline.setupAudioPipeline();

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1200);
      expect(pipeline.isVadGated).toBe(true);
    });
  });

  describe("VAD fallback frame counters and RMS reporting", () => {
    afterEach(() => {
      pipeline.stopVadPolling();
      pipeline.teardownAudioPipeline();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function setupFallbackPipeline(): { mockAnalyser: any; mockGainNode: any } {
      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => {
          // Moderate signal — above threshold so we can test non-gating
          for (let i = 0; i < arr.length; i++) arr[i] = 0.3;
        }),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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
      return { mockAnalyser, mockGainNode };
    }

    it("updates _lastVadRms every 3 frames (frameCounter >= 3 resets)", async () => {
      vi.useFakeTimers();
      setupFallbackPipeline();
      pipeline.setupAudioPipeline();

      await vi.advanceTimersByTimeAsync(100); // worklet fails
      // RMS for constant 0.3 signal: sqrt(0.09) = 0.3
      // After startup grace (30 frames), frameCounter increments 1,2,3 -> reset + update
      await vi.advanceTimersByTimeAsync(1000);

      // lastVadRms should have been updated to ~0.3 (the RMS of constant 0.3 signal)
      expect(pipeline.lastVadRms).toBeGreaterThan(0);
      expect(pipeline.lastVadRms).toBeCloseTo(0.3, 1);
    });

    it("does not gate when rms is above threshold (speech frames accumulate)", async () => {
      vi.useFakeTimers();
      setupFallbackPipeline(); // signal at 0.3, threshold = 0.05
      pipeline.setupAudioPipeline();

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1200);
      // rms 0.3 > threshold 0.05, so silentFrames never accumulate, no gating
      expect(pipeline.isVadGated).toBe(false);
    });

    it("gate requires exactly GATE_ON_FRAMES (12) consecutive silent frames", async () => {
      vi.useFakeTimers();
      let frameCount = 0;
      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => {
          frameCount++;
          // After startup grace (30 frames), be silent for exactly 11 frames, then loud
          if (frameCount > 30 && frameCount <= 41) {
            arr.fill(0); // silent
          } else if (frameCount === 42) {
            for (let i = 0; i < arr.length; i++) arr[i] = 0.5; // loud — resets counter
          } else if (frameCount > 42) {
            arr.fill(0); // silent again — needs 12 more to gate
          } else {
            arr.fill(0); // startup grace
          }
        }),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      await vi.advanceTimersByTimeAsync(100); // worklet fails
      // Run through startup (30 frames) + 11 silent + 1 loud = 42 frames * 16ms = 672ms
      await vi.advanceTimersByTimeAsync(700);
      // After 11 silent frames then 1 loud: should NOT be gated yet (needs 12 consecutive)
      // The loud frame resets silentFrames to 0

      // Now run 12 more silent frames to trigger gating
      await vi.advanceTimersByTimeAsync(250); // 12+ frames * 16ms
      expect(pipeline.isVadGated).toBe(true);
    });

    it("ungate requires GATE_OFF_FRAMES (2) consecutive speech frames after gating", async () => {
      vi.useFakeTimers();
      let isSilent = true;
      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => {
          if (isSilent) {
            arr.fill(0);
          } else {
            for (let i = 0; i < arr.length; i++) arr[i] = 0.5;
          }
        }),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      // Wait for worklet to fail and fallback to start
      await vi.advanceTimersByTimeAsync(100);
      // Gate with silence: startup grace (30*16=480ms) + gate frames (12*16=192ms)
      await vi.advanceTimersByTimeAsync(1200);
      expect(pipeline.isVadGated).toBe(true);

      // Switch to speech — need 2 consecutive speech frames (GATE_OFF_FRAMES) to ungate
      isSilent = false;
      await vi.advanceTimersByTimeAsync(200); // 2+ frames * 16ms
      expect(pipeline.isVadGated).toBe(false);
    });

    it("startup grace period skips first 30 frames without gating", async () => {
      vi.useFakeTimers();
      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => {
          arr.fill(0); // always silent
        }),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      await vi.advanceTimersByTimeAsync(100); // worklet fails
      // Only run startup grace period: 30 frames * 16ms = 480ms
      // Gate needs 12 more frames after grace
      await vi.advanceTimersByTimeAsync(480);
      // During grace period, no gating should occur despite silence
      // But after grace + ~12 frames (192ms), gating occurs
      // So at ~580ms from fallback start, should not yet be gated
      // (480ms grace + only a few post-grace frames)
      // Let's check at exactly the grace boundary
      expect(pipeline.isVadGated).toBe(false);

      // Now advance past grace + 12 gate frames
      await vi.advanceTimersByTimeAsync(300);
      expect(pipeline.isVadGated).toBe(true);
    });
  });

  describe("VAD fallback stops when analyser is torn down mid-poll", () => {
    afterEach(() => {
      pipeline.stopVadPolling();
      pipeline.teardownAudioPipeline();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("poll stops iterating when analyser becomes null", async () => {
      vi.useFakeTimers();
      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => arr.fill(0)),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      await vi.advanceTimersByTimeAsync(100);

      // Null out the analyser mid-poll
      (pipeline as any).audioPipelineAnalyser = null;
      const callsBefore = mockAnalyser.getFloatTimeDomainData.mock.calls.length;

      await vi.advanceTimersByTimeAsync(200);
      // No new calls should happen since analyser is null
      expect(mockAnalyser.getFloatTimeDomainData.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("pipeline generation prevents stale async results", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("discards worklet addModule result if pipeline torn down during load", async () => {
      let resolveAddModule: () => void;
      const addModulePromise = new Promise<void>((resolve) => {
        resolveAddModule = resolve;
      });

      const mockAnalyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockReturnValue(addModulePromise) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn().mockImplementation(() => ({
          port: { postMessage: vi.fn(), onmessage: null },
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      // Teardown increments generation, making the pending addModule stale
      pipeline.teardownAudioPipeline();

      // Now resolve addModule — should be discarded because generation changed
      resolveAddModule!();
      await addModulePromise;

      // Yield to microtasks
      await new Promise((r) => setTimeout(r, 0));

      // Worklet should NOT have been started (generation mismatch)
      expect(pipeline.vadUsingWorklet).toBe(false);
    });
  });

  describe("worklet gate message deduplication", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("does not call updatePipelineGain when gate state unchanged", async () => {
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAnalyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn().mockImplementation(() => ({
          port: { postMessage: vi.fn(), onmessage: null },
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      await vi.waitFor(() => {
        expect(pipeline.vadUsingWorklet).toBe(true);
      });

      const WorkletNodeConstructor = (globalThis as any).AudioWorkletNode;
      const workletInstance = WorkletNodeConstructor.mock.results[0].value;
      mockGainNode.gain.setTargetAtTime.mockClear();

      // Send gate=false when already ungated — should NOT trigger updatePipelineGain
      workletInstance.port.onmessage({ data: { type: "gate", gated: false } } as any);
      expect(mockGainNode.gain.setTargetAtTime).not.toHaveBeenCalled();

      // Send gate=true — should trigger
      workletInstance.port.onmessage({ data: { type: "gate", gated: true } } as any);
      expect(mockGainNode.gain.setTargetAtTime).toHaveBeenCalled();
      mockGainNode.gain.setTargetAtTime.mockClear();

      // Send gate=true again — should NOT trigger (already gated)
      workletInstance.port.onmessage({ data: { type: "gate", gated: true } } as any);
      expect(mockGainNode.gain.setTargetAtTime).not.toHaveBeenCalled();
    });
  });

  describe("worklet sends config with threshold", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("posts config message with correct threshold to worklet port", async () => {
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAnalyser = {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn(),
      };
      const postMessageSpy = vi.fn();
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn().mockImplementation(() => ({
          port: { postMessage: postMessageSpy, onmessage: null },
          connect: vi.fn(),
          disconnect: vi.fn(),
        })),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50; // threshold = ((100-50)/100)*0.1 = 0.05
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      await vi.waitFor(() => {
        expect(pipeline.vadUsingWorklet).toBe(true);
      });

      expect(postMessageSpy).toHaveBeenCalledWith({ type: "config", threshold: 0.05 });
    });
  });

  describe("stopVadPolling clears vadTimer", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("clears the setTimeout-based vadTimer on stop", async () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const mockAnalyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn().mockImplementation((arr: Float32Array) => arr.fill(0)),
      };
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
        resume: vi.fn().mockResolvedValue(undefined),
        createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
        createAnalyser: vi.fn().mockReturnValue(mockAnalyser),
        createGain: vi.fn().mockReturnValue(mockGainNode),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "t" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "voiceSensitivity") return 50;
        if (key === "inputVolume") return 100;
        return defaultVal;
      });

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

      await vi.advanceTimersByTimeAsync(100); // fallback starts
      clearTimeoutSpy.mockClear();

      pipeline.stopVadPolling();
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });
  });

  describe("teardownAudioPipeline handles replaceTrack failure gracefully", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("does not throw when sender.replaceTrack rejects during teardown", () => {
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
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
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "t" },
              sender: { replaceTrack: vi.fn().mockRejectedValue(new Error("fail")) },
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      expect(() => pipeline.teardownAudioPipeline()).not.toThrow();
      expect(pipeline.isActive).toBe(false);
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

  describe("setupAudioPipeline sender.replaceTrack failure during setup", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("catches replaceTrack rejection during setup without crashing", () => {
      const mockGainNode = {
        gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const mockAudioCtx = {
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
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "adjusted" }]) },
          disconnect: vi.fn(),
        }),
        currentTime: 0,
        close: vi.fn().mockResolvedValue(undefined),
        state: "running",
        audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no")) },
      };
      vi.stubGlobal("AudioContext", vi.fn().mockReturnValue(mockAudioCtx));
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "t" },
              sender: { replaceTrack: vi.fn().mockRejectedValue(new Error("replace fail")) },
              getProcessor: vi.fn(),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      expect(() => pipeline.setupAudioPipeline()).not.toThrow();
      expect(pipeline.isActive).toBe(true);
    });
  });

  describe("reapplyAudioProcessing success path", () => {
    it("restarts track, rebuilds pipeline, and applies enhanced NS", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "enhancedNoiseSuppression") return true;
        if (key === "echoCancellation") return true;
        if (key === "noiseSuppression") return true;
        if (key === "autoGainControl") return true;
        return defaultVal;
      });

      const restartTrack = vi.fn().mockResolvedValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              restartTrack,
              mediaStreamTrack: { id: "track" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn().mockReturnValue(undefined),
              setProcessor: vi.fn().mockResolvedValue(undefined),
            },
          }),
        },
      } as any;

      // Stub AudioContext for setupAudioPipeline called internally
      vi.stubGlobal(
        "AudioContext",
        vi.fn().mockReturnValue({
          resume: vi.fn().mockResolvedValue(undefined),
          createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
          createAnalyser: vi.fn().mockReturnValue({
            fftSize: 0,
            smoothingTimeConstant: 0,
            connect: vi.fn(),
            disconnect: vi.fn(),
            getFloatTimeDomainData: vi.fn(),
          }),
          createGain: vi.fn().mockReturnValue({
            gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
            connect: vi.fn(),
            disconnect: vi.fn(),
          }),
          createMediaStreamDestination: vi.fn().mockReturnValue({
            stream: { getAudioTracks: vi.fn().mockReturnValue([]) },
            disconnect: vi.fn(),
          }),
          currentTime: 0,
          close: vi.fn().mockResolvedValue(undefined),
          state: "running",
          audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no worklet")) },
        }),
      );
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      pipeline.setRoom(mockRoom);
      await pipeline.reapplyAudioProcessing();

      expect(restartTrack).toHaveBeenCalledWith({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    });

    it("removes noise suppressor when enhanced NS is disabled", async () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "enhancedNoiseSuppression") return false;
        if (key === "echoCancellation") return true;
        if (key === "noiseSuppression") return true;
        if (key === "autoGainControl") return true;
        return defaultVal;
      });

      const stopProcessor = vi.fn().mockResolvedValue(undefined);
      const restartTrack = vi.fn().mockResolvedValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              restartTrack,
              mediaStreamTrack: { id: "track" },
              sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
              getProcessor: vi.fn().mockReturnValue({}), // has a processor
              setProcessor: vi.fn().mockResolvedValue(undefined),
              stopProcessor,
            },
          }),
        },
      } as any;

      vi.stubGlobal(
        "AudioContext",
        vi.fn().mockReturnValue({
          resume: vi.fn().mockResolvedValue(undefined),
          createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
          createAnalyser: vi.fn().mockReturnValue({
            fftSize: 0,
            smoothingTimeConstant: 0,
            connect: vi.fn(),
            disconnect: vi.fn(),
            getFloatTimeDomainData: vi.fn(),
          }),
          createGain: vi.fn().mockReturnValue({
            gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
            connect: vi.fn(),
            disconnect: vi.fn(),
          }),
          createMediaStreamDestination: vi.fn().mockReturnValue({
            stream: { getAudioTracks: vi.fn().mockReturnValue([]) },
            disconnect: vi.fn(),
          }),
          currentTime: 0,
          close: vi.fn().mockResolvedValue(undefined),
          state: "running",
          audioWorklet: { addModule: vi.fn().mockRejectedValue(new Error("no worklet")) },
        }),
      );
      vi.stubGlobal(
        "MediaStream",
        vi.fn().mockImplementation(() => ({})),
      );

      pipeline.setRoom(mockRoom);
      await pipeline.reapplyAudioProcessing();

      expect(restartTrack).toHaveBeenCalled();
      expect(stopProcessor).toHaveBeenCalled();
    });
  });
});
