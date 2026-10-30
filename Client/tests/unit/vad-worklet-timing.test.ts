// Pins OC-0206: AudioWorkletProcessor.process() runs once per 128-sample
// render quantum (2.667ms at the 48kHz AudioContext AudioPipeline creates),
// not once per ~16ms poll like the setTimeout fallback. vad-worklet.js's gate
// timing constants were copy-pasted from the fallback's 16ms-poll frame
// counts, so on the worklet path the mic gate closes ~6x faster than
// intended (~32ms of silence instead of ~200ms), and the other timing
// constants are off by the same factor.
//
// This loads the actual public/vad-worklet.js source (not a reimplementation)
// into a small VM sandbox that stands in for the AudioWorkletGlobalScope, so
// it exercises the real VadProcessor class.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKLET_PATH = resolve(__dirname, "../../public/vad-worklet.js");

// One render quantum at the 48kHz AudioContext AudioPipeline creates
// (audioPipeline.ts: `new AudioContext({ sampleRate: 48000 })`).
const FRAME_MS = (128 / 48000) * 1000; // ≈ 2.667ms

function loadVadProcessor(): new () => any {
  const code = readFileSync(WORKLET_PATH, "utf-8");
  const registered: Record<string, new () => any> = {};

  class AudioWorkletProcessor {
    port: { onmessage: ((event: unknown) => void) | null; postMessage: (msg: unknown) => void };
    constructor() {
      this.port = { onmessage: null, postMessage: () => {} };
    }
  }

  const sandbox: Record<string, unknown> = {
    AudioWorkletProcessor,
    registerProcessor: (name: string, cls: new () => unknown) => {
      registered[name] = cls as new () => any;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "vad-worklet.js" });
  const ctor = registered["vad-processor"];
  if (ctor === undefined) {
    throw new Error('vad-worklet.js did not registerProcessor("vad-processor")');
  }
  return ctor;
}

function frame(value: number, length = 128): Float32Array {
  return new Float32Array(length).fill(value);
}

function postMessageMock(proc: any): ReturnType<typeof vi.fn> {
  return proc.port.postMessage as ReturnType<typeof vi.fn>;
}

/** Repeatedly calls process() with a constant-level input frame until
 *  port.postMessage receives a message of `type`, returning the number of
 *  process() calls that took (the call that produced the message counts). */
function callsUntilMessageOfType(
  proc: any,
  sampleValue: number,
  type: string,
  maxCalls: number,
): number {
  for (let i = 1; i <= maxCalls; i++) {
    const before = postMessageMock(proc).mock.calls.length;
    proc.process([[frame(sampleValue)]]);
    const calls = postMessageMock(proc).mock.calls;
    for (let j = before; j < calls.length; j++) {
      const call = calls[j];
      if (call === undefined) continue;
      if ((call[0] as { type: string }).type === type) return i;
    }
  }
  throw new Error(`no "${type}" message within ${maxCalls} process() calls`);
}

describe("vad-worklet.js VadProcessor timing (128-sample render quanta @48kHz)", () => {
  const SILENT = 0; // rms 0, below default threshold 0.05
  const LOUD = 0.5; // rms 0.5, above default threshold 0.05

  function freshUngatedProcessor(): any {
    const VadProcessor = loadVadProcessor();
    const proc = new VadProcessor();
    proc.port.postMessage = vi.fn();
    // Fast-forward well past the startup grace period with loud (non-gating)
    // audio. Starting ungated, loud audio never posts a "gate" message, so
    // this is safe regardless of how long the grace period actually is.
    for (let i = 0; i < 300; i++) proc.process([[frame(LOUD)]]);
    return proc;
  }

  it("does not close the gate until ~500ms below the threshold (188 render quanta), not ~32ms (12 quanta)", () => {
    const proc = freshUngatedProcessor();

    const calls = callsUntilMessageOfType(proc, SILENT, "gate", 300);
    const elapsedMs = calls * FRAME_MS;

    // 12 quanta (the wrong constant) is ~32ms — well under 150ms. The hold is
    // ~500ms (188 quanta) plus the 4-quantum smoothing window draining.
    expect(elapsedMs).toBeGreaterThan(460);
    expect(elapsedMs).toBeLessThan(560);
  });

  it("does not reopen the gate until ~32ms of speech (≈12 render quanta), not ~5ms (2 quanta)", () => {
    const proc = freshUngatedProcessor();

    // Drive it into the gated state first.
    callsUntilMessageOfType(proc, SILENT, "gate", 200);
    postMessageMock(proc).mockClear();

    const calls = callsUntilMessageOfType(proc, LOUD, "gate", 200);
    const elapsedMs = calls * FRAME_MS;

    // 2 quanta (current) is ~5.3ms. 12 quanta (~32ms) plus the smoothing
    // window filling is intended.
    expect(elapsedMs).toBeGreaterThan(20);
    expect(elapsedMs).toBeLessThan(55);
  });

  it("suppresses all messages for close to 500ms of startup grace (≈188 quanta), not ~80ms (30 quanta)", () => {
    const VadProcessor = loadVadProcessor();
    const proc = new VadProcessor();
    proc.port.postMessage = vi.fn();

    // 160 quanta ≈ 427ms: comfortably past the current, wrong 30-quantum
    // (~80ms) grace plus the current 12-quantum gate-on delay, but still
    // short of the intended ~500ms grace.
    for (let i = 0; i < 160; i++) proc.process([[frame(SILENT)]]);

    expect(postMessageMock(proc)).not.toHaveBeenCalled();
  });

  it("posts the RMS indicator roughly every ~50ms (≈19 quanta) once past startup, not every ~16ms (6 quanta)", () => {
    const proc = freshUngatedProcessor();

    // Discard the first (possibly phase-shifted) interval, then measure a
    // full period: the counter resets to 0 immediately after each post.
    callsUntilMessageOfType(proc, LOUD, "rms", 300);
    postMessageMock(proc).mockClear();
    const period = callsUntilMessageOfType(proc, LOUD, "rms", 100);
    const periodMs = period * FRAME_MS;

    // 6 quanta (current) is ~16ms. 19 quanta (~50ms) is intended.
    expect(periodMs).toBeGreaterThan(35);
    expect(periodMs).toBeLessThan(65);
  });

  it("a threshold message moves the level without reopening the gate or resetting the hold", () => {
    // Automatic sensitivity re-sends the threshold as the noise floor moves:
    // unlike config, that must not reopen a closed gate.
    const proc = freshUngatedProcessor();
    callsUntilMessageOfType(proc, SILENT, "gate", 200);
    postMessageMock(proc).mockClear();
    const QUIET = 0.02; // below 0.05, above 0.01
    for (let i = 0; i < 20; i++) proc.process([[frame(QUIET)]]);

    proc.port.onmessage({ data: { type: "threshold", threshold: 0.01 } });
    expect(postMessageMock(proc)).not.toHaveBeenCalledWith({ type: "gate", gated: false });
    expect(proc._threshold).toBe(0.01);
    // The level now clears the moved threshold: speech opens the gate after
    // the usual ~32 ms attack, not at once.
    const calls = callsUntilMessageOfType(proc, QUIET, "gate", 200);
    expect(calls * FRAME_MS).toBeGreaterThan(20);
    expect(calls * FRAME_MS).toBeLessThan(55);
  });

  it("closes only 6 dB under the threshold: a level between the two keeps the gate open", () => {
    const proc = freshUngatedProcessor();
    // Default threshold 0.05; 0.03 is 4.4 dB under it, inside the hysteresis.
    for (let i = 0; i < 400; i++) proc.process([[frame(0.03)]]);
    expect(postMessageMock(proc)).not.toHaveBeenCalledWith({ type: "gate", gated: true });
    // 0.02 is 8 dB under: the hold starts and the gate closes.
    const calls = callsUntilMessageOfType(proc, 0.02, "gate", 300);
    expect(calls * FRAME_MS).toBeGreaterThan(460);
    expect(calls * FRAME_MS).toBeLessThan(560);
  });

  it("reopens at the threshold itself, not at the lower close level", () => {
    const proc = freshUngatedProcessor();
    callsUntilMessageOfType(proc, SILENT, "gate", 300);
    postMessageMock(proc).mockClear();
    for (let i = 0; i < 100; i++) proc.process([[frame(0.03)]]);
    expect(postMessageMock(proc)).not.toHaveBeenCalledWith({ type: "gate", gated: false });
    callsUntilMessageOfType(proc, LOUD, "gate", 100);
  });

  it("one quiet quantum inside an onset does not start the attack over", () => {
    const proc = freshUngatedProcessor();
    callsUntilMessageOfType(proc, SILENT, "gate", 300);
    postMessageMock(proc).mockClear();
    // 8 loud quanta, a dip, then loud again: 12 loud in all open it, where a
    // consecutive count would need 12 after the dip.
    for (let i = 0; i < 8; i++) proc.process([[frame(LOUD)]]);
    proc.process([[frame(SILENT)]]);
    const calls = callsUntilMessageOfType(proc, LOUD, "gate", 100);
    // The dip costs one count and the smoothing window a little more.
    expect(calls).toBeLessThan(10);
  });

  describe("with the speech gate on", () => {
    /** One quantum of audio at `level`, with RNNoise's verdict `probability`. */
    const quantum = (level: number, probability: number) => [[frame(level)], [frame(probability)]];

    function speechGated(): any {
      const proc = freshUngatedProcessor();
      proc.port.onmessage({ data: { type: "speechGate", on: true } });
      return proc;
    }

    it("a loud quantum RNNoise calls noise does not open a closed gate", () => {
      const proc = speechGated();
      callsUntilMessageOfType(proc, SILENT, "gate", 300);
      postMessageMock(proc).mockClear();
      for (let i = 0; i < 400; i++) proc.process(quantum(LOUD, 0.2));
      expect(postMessageMock(proc)).not.toHaveBeenCalledWith({ type: "gate", gated: false });
      // A voice at the same level opens it after the attack.
      for (let i = 0; i < 12; i++) proc.process(quantum(LOUD, 0.9));
      expect(postMessageMock(proc)).toHaveBeenCalledWith({ type: "gate", gated: false });
    });

    it("gates on the level alone while the probability input is silent (no RNNoise)", () => {
      const proc = speechGated();
      callsUntilMessageOfType(proc, SILENT, "gate", 300);
      postMessageMock(proc).mockClear();
      // An exact 0 is not a verdict: RNNoise is not there (a running one
      // reports at least its floor), so a loud level opens the gate.
      for (let i = 0; i < 12; i++) proc.process(quantum(LOUD, 0));
      expect(postMessageMock(proc)).toHaveBeenCalledWith({ type: "gate", gated: false });
    });

    it("a level above the gate that RNNoise stops calling voice closes it after the hold", () => {
      const proc = speechGated();
      for (let i = 0; i < 100; i++) proc.process(quantum(LOUD, 0.9));
      expect(postMessageMock(proc)).not.toHaveBeenCalledWith({ type: "gate", gated: true });
      let calls = 0;
      for (; calls < 300; calls++) {
        proc.process(quantum(LOUD, 0.05));
        if (postMessageMock(proc).mock.calls.some((c) => (c[0] as any).gated === true)) break;
      }
      expect(calls * FRAME_MS).toBeGreaterThan(460);
      expect(calls * FRAME_MS).toBeLessThan(560);
    });

    it("a dip of the probability inside a word is bridged by the hold", () => {
      const proc = speechGated();
      for (let i = 0; i < 100; i++) proc.process(quantum(LOUD, 0.9));
      // 100 ms of a stop consonant: RNNoise says no voice, the level is low.
      for (let i = 0; i < 38; i++) proc.process(quantum(SILENT, 0.0));
      for (let i = 0; i < 100; i++) proc.process(quantum(LOUD, 0.9));
      expect(postMessageMock(proc)).not.toHaveBeenCalledWith({ type: "gate", gated: true });
    });

    it("an unconnected probability input gates on the level alone", () => {
      const proc = speechGated();
      callsUntilMessageOfType(proc, SILENT, "gate", 300);
      postMessageMock(proc).mockClear();
      for (let i = 0; i < 12; i++) proc.process([[frame(LOUD)], []]);
      expect(postMessageMock(proc)).toHaveBeenCalledWith({ type: "gate", gated: false });
    });

    it("turning the rule off reverts to the level alone without restarting the gate", () => {
      const proc = speechGated();
      callsUntilMessageOfType(proc, SILENT, "gate", 300);
      postMessageMock(proc).mockClear();
      proc.port.onmessage({ data: { type: "speechGate", on: false } });
      expect(postMessageMock(proc)).not.toHaveBeenCalled();
      for (let i = 0; i < 12; i++) proc.process(quantum(LOUD, 0.0));
      expect(postMessageMock(proc)).toHaveBeenCalledWith({ type: "gate", gated: false });
    });
  });

  it("acknowledges stop from its final process() call", () => {
    // audioPipeline.ts closes the AudioContext on this acknowledgement.
    const proc = freshUngatedProcessor();
    postMessageMock(proc).mockClear();
    proc.port.onmessage({ data: { type: "stop" } });

    expect(proc.process([[frame(LOUD)]])).toBe(false);
    expect(postMessageMock(proc)).toHaveBeenCalledWith({ type: "stopped" });
  });
});
