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

    it("discards worklet addModule result if stopVadPolling is called without a teardown", async () => {
      // Same setup as above, but this time only stopVadPolling() runs (e.g. the
      // user set sensitivity to 100) — teardownAudioPipeline() is NOT called, so
      // the pipeline (and _pipelineGeneration) stays intact. The in-flight
      // addModule from the earlier startVadPolling must still be invalidated by
      // its own generation, or it resurrects VAD with the stale threshold.
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

      // Stop VAD (not a full teardown) while addModule is still in flight —
      // e.g. the user dragged sensitivity to 100.
      pipeline.stopVadPolling();

      // Now resolve addModule — should be discarded because stopVadPolling
      // invalidated the in-flight call.
      resolveAddModule!();
      await addModulePromise;

      // Yield to microtasks
      await new Promise((r) => setTimeout(r, 0));

      // Worklet should NOT have been (re)started — VAD is meant to be off.
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
});
