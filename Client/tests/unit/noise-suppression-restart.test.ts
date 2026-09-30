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

import { createRNNoiseProcessor } from "../../src/lib/noise-suppression";
import type { AudioProcessorOptions } from "livekit-client";

function makeFakeAudioContext() {
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  const destTrack = { id: "dest-track", kind: "audio" } as unknown as MediaStreamTrack;
  const destNode = {
    stream: { getAudioTracks: () => [destTrack] },
    disconnect: vi.fn(),
  };
  return {
    createMediaStreamSource: vi.fn().mockReturnValue(sourceNode),
    createMediaStreamDestination: vi.fn().mockReturnValue(destNode),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
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
    // jsdom has no AudioWorklet or WASM fetch: stand in for the worklet node,
    // which answers the init message with "ready" as rnnoise-worklet.js does.
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        port = {
          onmessage: null as ((event: { data: { type: string } }) => void) | null,
          postMessage: (message: { type: string }) => {
            if (message.type === "init")
              queueMicrotask(() => this.port.onmessage?.({ data: { type: "ready" } }));
          },
        };
        connect = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
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
