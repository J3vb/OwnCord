import { afterEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import { createRNNoiseProcessor } from "../../src/lib/noise-suppression";

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

// src/lib/noise-suppression.ts needs a real AudioContext/AudioWorklet/WASM
// runtime that jsdom cannot provide (vitest.config.ts excludes it from
// coverage on that basis) — so it has to be exercised here, not in
// tests/unit. Every tests/unit reference to it is a vi.mock().
describe("noise-suppression (real AudioContext)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the AudioWorklet pipeline with the shipped minified RNNoise WASM", async () => {
    const audioContext = new AudioContext();
    const inputTrack = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0]!;

    try {
      const processor = createRNNoiseProcessor();
      await processor.init({
        kind: Track.Kind.Audio,
        track: inputTrack,
        audioContext,
      });

      // init() resolves only once the worklet reports the WASM ready, which
      // proves the minified export mapping worked.
      expect(processor.processedTrack).toBeInstanceOf(MediaStreamTrack);

      await processor.destroy();
    } finally {
      await audioContext.close();
    }
  });
});
