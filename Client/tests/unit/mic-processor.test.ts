import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import { createMicProcessor, GATE_LOOKAHEAD_S } from "../../src/lib/micProcessor";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

async function started() {
  const processor = createMicProcessor();
  await processor.init({ kind: Track.Kind.Audio, track: fakeMediaStreamTrack("mic") } as never);
  const ctx = processor.context as unknown as FakeAudioContext;
  const [entry, output] = ctx.nodes.filter((n) => n.kind === "gain");
  return { processor, ctx, entry: entry!, output: output! };
}

/** Answer the RNNoise worklet's init once it exists. */
async function ready(): Promise<FakeAudioWorkletNode> {
  await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
  const node = FakeAudioWorkletNode.instances[0]!;
  node.emit({ type: "ready" });
  return node;
}

describe("createMicProcessor", () => {
  beforeEach(() => {
    installFakeAudio();
    FakeAudioWorkletNode.instances = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("runs its own 48 kHz context: source → entry → analyser tap, and → delay → gain → output", async () => {
    const { processor, ctx, entry, output } = await started();

    expect(ctx.sampleRate).toBe(48000);
    const source = ctx.latest("source");
    expect(ctx.reaches(source, entry)).toBe(true);
    expect(ctx.reaches(entry, ctx.node("analyser"))).toBe(true);
    expect(ctx.reaches(entry, ctx.node("delay"))).toBe(true);
    expect(ctx.reaches(ctx.node("delay"), output)).toBe(true);
    expect(ctx.reaches(output, ctx.node("destination"))).toBe(true);
    // The detector taps ahead of the delay and gain: it sees the level, not the gate.
    expect(ctx.reaches(ctx.node("analyser"), output)).toBe(false);
    expect(processor.processedTrack).toBe(ctx.outputTrack);
    expect(ctx.node("delay").maxDelay).toBe(GATE_LOOKAHEAD_S);
  });

  it("gates the output: either gate closed is silence, both open is the input gain", async () => {
    const { processor, entry, output } = await started();
    // Input Volume rides on the entry node, ahead of the detector's tap; the
    // output node carries only the gates.
    const level = () => entry.gain.value * output.gain.value;
    processor.setInputGain(0.8);
    expect(entry.gain.value).toBe(0.8);
    expect(level()).toBe(0.8);

    processor.setGate("vad", true);
    expect(level()).toBe(0);
    expect(entry.gain.value).toBe(0.8);
    processor.setGate("ptt", true);
    processor.setGate("vad", false);
    expect(level()).toBe(0);
    processor.setGate("ptt", false);
    expect(level()).toBe(0.8);
    expect(processor.gainValue).toBe(0.8);
    expect(processor.isGateClosed("vad")).toBe(false);
  });

  it("opens fast and closes gently", async () => {
    const { processor, output } = await started();
    processor.setGate("vad", true);
    processor.setGate("vad", false);

    const constants = output.gain.setTargetAtTime.mock.calls.map(([, , tc]: number[]) => tc);
    expect(constants.slice(-2)).toEqual([0.015, 0.005]);
  });

  it("starts with the gates it was given before init", async () => {
    const processor = createMicProcessor();
    processor.setGate("ptt", true);
    processor.setInputGain(1.5);
    await processor.init({ kind: Track.Kind.Audio, track: fakeMediaStreamTrack("mic") } as never);

    const ctx = processor.context as unknown as FakeAudioContext;
    const [entry, output] = ctx.nodes.filter((n) => n.kind === "gain");
    expect(entry!.gain.value).toBe(1.5);
    expect(output!.gain.value).toBe(0);
    processor.setGate("ptt", false);
    expect(output!.gain.value).toBe(1);
  });

  it("routes through RNNoise when enhanced, and around it again when not", async () => {
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    const { processor, ctx, entry } = await started();
    ctx.audioWorklet.addModule.mockResolvedValue(undefined);
    // The worklet answers init with ready.
    const enabling = processor.setEnhanced(true);
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    FakeAudioWorkletNode.instances[0]!.emit({ type: "ready" });
    await enabling;

    const rnnoise = FakeAudioWorkletNode.instances[0]!;
    expect(processor.enhanced).toBe(true);
    expect(entry.outputs).toEqual([rnnoise]);
    expect(rnnoise.connect).toHaveBeenCalledWith(ctx.node("analyser"));
    expect(rnnoise.connect).toHaveBeenCalledWith(ctx.node("delay"));

    await processor.setEnhanced(false);
    expect(processor.enhanced).toBe(false);
    expect(entry.outputs).toEqual([ctx.node("analyser"), ctx.node("delay")]);
    expect(rnnoise.disconnect).toHaveBeenCalled();
  });

  describe("with RNNoise loaded", () => {
    beforeEach(() => {
      vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
      );
    });

    // #1728: a context closed before a worklet's final process() call pins
    // the closed context (and RNNoise's WASM) for the page's lifetime.
    it("closes the context only after RNNoise's worklet has stopped", async () => {
      const { processor, ctx } = await started();
      ctx.audioWorklet.addModule.mockResolvedValue(undefined);
      const enabling = processor.setEnhanced(true);
      const rnnoise = await ready();
      await enabling;

      const destroying = processor.destroy();
      await Promise.resolve();
      expect(rnnoise.port.postMessage).toHaveBeenCalledWith({ type: "destroy" });
      expect(ctx.close).not.toHaveBeenCalled();

      rnnoise.emit({ type: "stopped" });
      await destroying;
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it("closes the context anyway when the worklet never reports stopped", async () => {
      vi.useFakeTimers();
      try {
        const { processor, ctx } = await started();
        ctx.audioWorklet.addModule.mockResolvedValue(undefined);
        const enabling = processor.setEnhanced(true);
        await vi.advanceTimersByTimeAsync(0);
        FakeAudioWorkletNode.instances[0]!.emit({ type: "ready" });
        await enabling;

        const destroying = processor.destroy();
        await vi.advanceTimersByTimeAsync(999);
        expect(ctx.close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await destroying;
        expect(ctx.close).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("settles toggles made while RNNoise loads on the last one, loading it once", async () => {
      const { processor, ctx, entry } = await started();
      ctx.audioWorklet.addModule.mockResolvedValue(undefined);

      const on = processor.setEnhanced(true);
      const off = processor.setEnhanced(false);
      const onAgain = processor.setEnhanced(true);
      const offAgain = processor.setEnhanced(false);
      await ready();
      await Promise.all([on, off, onAgain, offAgain]);

      expect(FakeAudioWorkletNode.instances).toHaveLength(1);
      expect(processor.enhanced).toBe(false);
      expect(entry.outputs).toEqual([ctx.node("analyser"), ctx.node("delay")]);
    });
  });

  it("stays off, and keeps passing audio, when RNNoise cannot load", async () => {
    const { processor, entry, ctx } = await started();

    await processor.setEnhanced(true);

    expect(processor.enhanced).toBe(false);
    expect(entry.outputs).toEqual([ctx.node("analyser"), ctx.node("delay")]);
  });

  it("swaps only the source on restart and closes the context on destroy", async () => {
    const { processor, ctx } = await started();
    const before = processor.processedTrack;

    await processor.restart({
      kind: Track.Kind.Audio,
      track: fakeMediaStreamTrack("mic-2"),
    } as never);
    expect(processor.processedTrack).toBe(before);
    expect(ctx.nodes.filter((n) => n.kind === "source")).toHaveLength(2);
    expect(ctx.nodes.filter((n) => n.kind === "source")[0]!.outputs).toEqual([]);

    await processor.destroy();
    await processor.destroy();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });
});
