// OC-0231: stopVadPolling() must detach the worklet's MessagePort handler so
// a "gate" message the worklet posts *after* stop() has already been sent
// (but before the audio thread has processed it) cannot re-gate the mic with
// no VAD left running to ever un-gate it again.
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

describe("AudioPipeline VAD worklet teardown (OC-0231)", () => {
  let pipeline: AudioPipeline;
  let mockGainNode: any;
  let mockAnalyserNode: any;
  let mockRoom: any;

  beforeEach(() => {
    vi.clearAllMocks();
    pipeline = new AudioPipeline();

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
    const mockDestNode = {
      stream: { getAudioTracks: vi.fn().mockReturnValue([{ id: "track" }]) },
      disconnect: vi.fn(),
    };
    const mockSourceNode = { connect: vi.fn() };
    const mockAudioCtx = {
      resume: vi.fn().mockResolvedValue(undefined),
      createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
      createAnalyser: vi.fn().mockReturnValue(mockAnalyserNode),
      createGain: vi.fn().mockReturnValue(mockGainNode),
      createMediaStreamDestination: vi.fn().mockReturnValue(mockDestNode),
      currentTime: 0,
      close: vi.fn().mockResolvedValue(undefined),
      state: "running",
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    };

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

    mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
      if (key === "voiceSensitivity") return 50;
      if (key === "inputVolume") return 100;
      return defaultVal;
    });
  });

  afterEach(() => {
    pipeline.teardownAudioPipeline();
    vi.unstubAllGlobals();
  });

  it("ignores a late 'gate:true' message delivered after stopVadPolling", async () => {
    pipeline.setRoom(mockRoom);
    pipeline.setupAudioPipeline();

    await vi.waitFor(() => {
      expect(pipeline.vadUsingWorklet).toBe(true);
    });

    const WorkletNodeConstructor = (globalThis as any).AudioWorkletNode;
    const workletInstance = WorkletNodeConstructor.mock.results[0].value;

    // sensitivity dragged to 100: setVoiceSensitivity(100) stops VAD without
    // restarting it (mirrors audioPipeline.ts setVoiceSensitivity clamped>=100 branch)
    pipeline.stopVadPolling();
    expect(pipeline.isVadGated).toBe(false);

    // The worklet's audio-thread process() loop was mid-flight when `stop`
    // was posted and still emits one more "gate" message before it honors
    // `_active = false`. That message arrives on the *same* port object the
    // pipeline handed out, after stopVadPolling() already ran.
    expect(workletInstance.port.onmessage).toBeNull();
    workletInstance.port.onmessage?.({ data: { type: "gate", gated: true } } as MessageEvent);

    // Must stay ungated — there is no VAD left running to ever undo this.
    expect(pipeline.isVadGated).toBe(false);
    // And the pipeline gain must not have been driven to 0 by the stale message.
    mockGainNode.gain.setTargetAtTime.mockClear();
  });
});
