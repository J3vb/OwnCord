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
        vi.fn(function () {
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

  // --- B3-1: pipeline must source from (and restore to) the NS processor's
  // output when one is attached, or the gain/VAD chain gets silently bypassed
  // by the processor's own replaceTrack ---

  describe("AudioPipeline sourcing when an NS processor is attached (B3-1)", () => {
    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    function stubAudioContext(): { mockSender: any } {
      const mockSender = { replaceTrack: vi.fn().mockResolvedValue(undefined) };
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
        createGain: vi.fn().mockReturnValue({
          gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        }),
        createMediaStreamDestination: vi.fn().mockReturnValue({
          stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "adjusted" }]) },
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
        vi.fn(function (tracks: unknown) {
          return { tracks };
        }),
      );
      return { mockSender };
    }

    it("setupAudioPipeline sources from the processor's processedTrack, not the raw mic track", () => {
      const { mockSender } = stubAudioContext();
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "raw-track" },
              sender: mockSender,
              getProcessor: vi.fn().mockReturnValue({ processedTrack: { id: "processed-track" } }),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();

      expect(MediaStream).toHaveBeenCalledWith([{ id: "processed-track" }]);
    });

    it("teardownAudioPipeline restores the sender to the processor's processedTrack, not the raw mic track, when NS is still attached", () => {
      const { mockSender } = stubAudioContext();
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "raw-track" },
              sender: mockSender,
              getProcessor: vi.fn().mockReturnValue({ processedTrack: { id: "processed-track" } }),
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);
      pipeline.setupAudioPipeline();
      mockSender.replaceTrack.mockClear();
      pipeline.teardownAudioPipeline();

      expect(mockSender.replaceTrack).toHaveBeenCalledWith({ id: "processed-track" });
    });

    it("applyNoiseSuppressor rebuilds the pipeline after attaching, so the sender ends on the gain/VAD chain instead of the processor's raw output winning", async () => {
      const { mockSender } = stubAudioContext();
      const setProcessor = vi.fn().mockResolvedValue(undefined);
      const mockRoom = {
        localParticipant: {
          getTrackPublication: vi.fn().mockReturnValue({
            track: {
              mediaStreamTrack: { id: "raw-track" },
              sender: mockSender,
              getProcessor: vi.fn().mockReturnValue(undefined), // no processor yet
              setProcessor,
            },
          }),
        },
      } as any;
      pipeline.setRoom(mockRoom);

      await pipeline.applyNoiseSuppressor();

      expect(setProcessor).toHaveBeenCalled();
      // The rebuilt pipeline's own replaceTrack (dest/adjusted track) must be
      // the LAST sender.replaceTrack call, so it wins over setProcessor's own
      // (unawaited, internal) replaceTrack to the raw processed track.
      const calls = mockSender.replaceTrack.mock.calls;
      expect(calls.at(-1)?.[0]).toEqual({ id: "adjusted" });
    });
  });

  describe("setupAudioPipeline AudioContext configuration", () => {
    let mockAudioCtx: any;

    afterEach(() => {
      pipeline.teardownAudioPipeline();
      vi.unstubAllGlobals();
    });

    it("creates AudioContext with sampleRate 48000", () => {
      const AudioContextSpy = vi.fn(function () {
        return audioCtxForSpy;
      });
      const audioCtxForSpy = {
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
      vi.stubGlobal("AudioContext", AudioContextSpy);
      vi.stubGlobal(
        "MediaStream",
        vi.fn(function () {
          return {};
        }),
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
        vi.fn(function () {
          return {};
        }),
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
        vi.fn(function () {
          return {};
        }),
      );

      pipeline.setRoom(mockRoom);
      await pipeline.reapplyAudioProcessing();

      expect(restartTrack).toHaveBeenCalled();
      expect(stopProcessor).toHaveBeenCalled();
    });
  });
});
