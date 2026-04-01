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

    it("updates persisted sensitivity even when no pipeline is active", () => {
      pipeline.setVoiceSensitivity(50);
      expect(pipeline.isVadGated).toBe(false);
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
