// OC-0277: RNNoise processor's restart() destroyed the live pipeline and
// then rebuilt it from opts.audioContext, which livekit-client's ONLY
// processor.restart() call site (LocalTrack.setMediaStreamTrack(), reached
// from restartTrack() on a device switch / mic replug / echo-cancellation
// toggle) never sends:
//
//   this.processor.restart({ track: newTrack, kind: this.kind, element: this.processorElement, localTrack: this })
//
// (contrast with setProcessor(), which does pass audioContext). Because the
// old pipeline was torn down before rebuilding, a restart with no cached
// AudioContext left `pipeline` null and the mic permanently silent until the
// user left and rejoined the voice channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// The ScriptProcessorNode fallback path is what jsdom actually exercises
// here (AudioWorkletNode/AudioContext are not defined in jsdom, so
// supportsAudioWorklet() is false) — mock the WASM module it depends on.
vi.mock("@jitsi/rnnoise-wasm", () => ({
  createRNNWasmModule: vi.fn(() => ({
    ready: Promise.resolve(),
    _rnnoise_create: vi.fn(() => 1),
    _rnnoise_destroy: vi.fn(),
    _rnnoise_process_frame: vi.fn(),
    _malloc: vi.fn(() => 0),
    _free: vi.fn(),
    HEAPF32: new Float32Array(4096),
  })),
}));

import { createRNNoiseProcessor } from "../../src/lib/noise-suppression";
import type { AudioProcessorOptions } from "livekit-client";

function makeFakeAudioContext() {
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  const destTrack = { id: "dest-track", kind: "audio" } as unknown as MediaStreamTrack;
  const destNode = {
    stream: { getAudioTracks: () => [destTrack] },
    disconnect: vi.fn(),
  };
  const processorNode = {
    onaudioprocess: null as unknown,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    createMediaStreamSource: vi.fn().mockReturnValue(sourceNode),
    createMediaStreamDestination: vi.fn().mockReturnValue(destNode),
    createScriptProcessor: vi.fn().mockReturnValue(processorNode),
  } as unknown as AudioContext;
}

describe("createRNNoiseProcessor restart (OC-0277)", () => {
  beforeEach(() => {
    // Must be a real constructor: noise-suppression.ts calls
    // `new MediaStream([inputTrack])` before handing the result to the (mocked,
    // argument-ignoring) createMediaStreamSource. A vi.fn() whose
    // implementation is an arrow function is not constructible, so Vitest 4
    // throws "is not a constructor" there instead of running the assertions.
    vi.stubGlobal(
      "MediaStream",
      class {
        tracks: unknown[];
        constructor(tracks: unknown[] = []) {
          this.tracks = tracks;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps producing a processed track across a restart() call that omits audioContext", async () => {
    const processor = createRNNoiseProcessor();
    const micTrack = { id: "mic-track", kind: "audio" } as unknown as MediaStreamTrack;
    const audioContext = makeFakeAudioContext();

    await processor.init({
      track: micTrack,
      audioContext,
      kind: "audio",
    } as unknown as AudioProcessorOptions);

    expect(processor.processedTrack).toBeDefined();

    // Mirrors livekit-client's real restart() call shape exactly — see
    // node_modules/livekit-client/dist/livekit-client.esm.mjs,
    // LocalTrack.setMediaStreamTrack(): no `audioContext` field.
    const newMicTrack = { id: "new-mic-track", kind: "audio" } as unknown as MediaStreamTrack;
    await expect(
      processor.restart({
        track: newMicTrack,
        kind: "audio",
      } as unknown as AudioProcessorOptions),
    ).resolves.toBeUndefined();

    expect(processor.processedTrack).toBeDefined();
  });
});
