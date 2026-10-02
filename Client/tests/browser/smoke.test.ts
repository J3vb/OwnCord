import { afterEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import { createMicProcessor } from "../../src/lib/micProcessor";

// Real-browser sanity checks: a real DOM is available (jsdom can fake this,
// but this suite runs in an actual Chromium instance via the vitest
// playwright provider).
describe("browser environment", () => {
  it("provides real DOM globals", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
    expect(typeof document.createElement).toBe("function");
  });

  it("real DOM APIs work", () => {
    const div = document.createElement("div");
    div.innerHTML = "<span>hello</span>";
    document.body.appendChild(div);

    const span = document.querySelector("span");
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("hello");

    div.remove();
  });
});

// src/lib/micProcessor.ts and src/lib/noise-suppression.ts need a real
// AudioContext/AudioWorklet/WASM runtime that jsdom cannot provide
// (vitest.config.ts excludes noise-suppression from coverage on that basis) —
// so they have to be exercised here, not in tests/unit.
describe("mic processor (real AudioContext)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds its graph and loads the RNNoise worklet with the shipped minified WASM", async () => {
    const feed = new AudioContext();
    const inputTrack = feed.createMediaStreamDestination().stream.getAudioTracks()[0]!;
    const processor = createMicProcessor();
    try {
      await processor.init({ kind: Track.Kind.Audio, track: inputTrack } as never);
      expect(processor.processedTrack).toBeInstanceOf(MediaStreamTrack);
      expect(processor.context.sampleRate).toBe(48000);

      // setEnhanced resolves true only once the worklet reports the WASM
      // ready, which proves the minified export mapping worked.
      await processor.setEnhanced(true);
      expect(processor.enhanced).toBe(true);
      await processor.setEnhanced(false);
      expect(processor.enhanced).toBe(false);
    } finally {
      await processor.destroy();
      await feed.close();
    }
  });
});
