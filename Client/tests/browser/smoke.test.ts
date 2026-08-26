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

  it("falls back to a ScriptProcessorNode pipeline when AudioWorklet is unsupported", async () => {
    const originalAudioWorkletNode = window.AudioWorkletNode;
    // @ts-expect-error -- deleting a required DOM global to force the
    // module's supportsAudioWorklet() feature check to fail
    delete window.AudioWorkletNode;

    const audioContext = new AudioContext();
    const scriptProcessorSpy = vi.spyOn(audioContext, "createScriptProcessor");
    const inputTrack = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0]!;

    try {
      const processor = createRNNoiseProcessor();
      await processor.init({
        kind: Track.Kind.Audio,
        track: inputTrack,
        audioContext,
      });

      // The fallback pipeline is the only thing that calls createScriptProcessor.
      expect(scriptProcessorSpy).toHaveBeenCalledTimes(1);
      expect(processor.processedTrack).toBeInstanceOf(MediaStreamTrack);
      expect(processor.processedTrack!.kind).toBe("audio");

      await processor.destroy();
    } finally {
      window.AudioWorkletNode = originalAudioWorkletNode;
      await audioContext.close();
    }
  });
});
