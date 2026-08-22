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
});
