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

  it("does not close the gate until ~200ms of silence (≈75 render quanta), not ~32ms (12 quanta)", () => {
    const proc = freshUngatedProcessor();

    const calls = callsUntilMessageOfType(proc, SILENT, "gate", 200);
    const elapsedMs = calls * FRAME_MS;

    // 12 quanta (the current, wrong constant) is ~32ms — well under 150ms.
    // 75 quanta (~200ms) is the intended timing.
    expect(elapsedMs).toBeGreaterThan(150);
    expect(elapsedMs).toBeLessThan(260);
  });

  it("does not reopen the gate until ~32ms of speech (≈12 render quanta), not ~5ms (2 quanta)", () => {
    const proc = freshUngatedProcessor();

    // Drive it into the gated state first.
    callsUntilMessageOfType(proc, SILENT, "gate", 200);
    postMessageMock(proc).mockClear();

    const calls = callsUntilMessageOfType(proc, LOUD, "gate", 200);
    const elapsedMs = calls * FRAME_MS;

    // 2 quanta (current) is ~5.3ms. 12 quanta (~32ms, matching the
    // setTimeout fallback's GATE_OFF_FRAMES=2 @ 16ms poll) is intended.
    expect(elapsedMs).toBeGreaterThan(20);
    expect(elapsedMs).toBeLessThan(45);
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
});
