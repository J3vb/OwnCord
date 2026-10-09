import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAudioTrack, Track } from "livekit-client";
import { AudioPipeline, startVadDetector, vadThreshold } from "../../src/lib/audioPipeline";
import type { MicProcessor } from "../../src/lib/micProcessor";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeMediaStream,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@lib/preferences", () => ({
  loadPref: (key: string, fallback: unknown) => (prefs.has(key) ? prefs.get(key) : fallback),
  savePref: (key: string, value: unknown) => prefs.set(key, value),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function micTrack(): LocalAudioTrack {
  const track = new LocalAudioTrack(fakeMediaStreamTrack("mic"), undefined, false);
  track.source = Track.Source.Microphone;
  return track;
}

const contextOf = (track: LocalAudioTrack): FakeAudioContext =>
  (track.getProcessor() as unknown as MicProcessor).context as unknown as FakeAudioContext;
/** Input Volume rides on the first gain node, ahead of the detector's tap. */
const inputGain = (ctx: FakeAudioContext) => ctx.nodes.filter((n) => n.kind === "gain")[0]!.gain;
const outputGain = (ctx: FakeAudioContext) => ctx.nodes.filter((n) => n.kind === "gain")[1]!.gain;

function roomWith(track: LocalAudioTrack | undefined) {
  return {
    localParticipant: {
      getTrackPublication: (source: string) =>
        source === Track.Source.Microphone && track !== undefined ? { track } : undefined,
    },
  } as never;
}

const rnnoise = () => FakeAudioWorkletNode.instances.find((w) => w.name === "rnnoise-processor");

describe("AudioPipeline", () => {
  beforeEach(() => {
    prefs.clear();
    installFakeAudio();
    FakeAudioWorkletNode.instances = [];
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream([fakeMediaStreamTrack("mic-2")])),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("push-to-talk gate", () => {
    it("is closed on the processor from the first sample when armed before the join's publish", async () => {
      const pipeline = new AudioPipeline();
      pipeline.setPttGated(true);
      const track = micTrack();

      await pipeline.attach(track);

      expect(outputGain(contextOf(track)).value).toBe(0);
      expect(pipeline.isPttGated).toBe(true);
    });

    it("opens on a press and closes on a release without touching the track", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      const restart = vi.spyOn(track, "restartTrack");
      const mute = vi.spyOn(track, "mute");

      pipeline.setPttGated(true);
      expect(outputGain(contextOf(track)).value).toBe(0);
      pipeline.setPttGated(false);
      expect(outputGain(contextOf(track)).value).toBe(1);
      expect(restart).not.toHaveBeenCalled();
      expect(mute).not.toHaveBeenCalled();
      expect(track.isMuted).toBe(false);
    });

    it("carries the gate onto the next processor: a reconnect's new track, the first press after it", async () => {
      const pipeline = new AudioPipeline();
      pipeline.setPttGated(true);
      await pipeline.attach(micTrack());
      const reconnected = micTrack();

      await pipeline.attach(reconnected);

      expect(outputGain(contextOf(reconnected)).value).toBe(0);
      pipeline.setPttGated(false);
      expect(outputGain(contextOf(reconnected)).value).toBe(1);
    });

    it("drives the room's own gate where the room has no web processor (the native room)", () => {
      const pipeline = new AudioPipeline();
      const setPttGated = vi.fn();
      pipeline.setRoom({
        localParticipant: { getTrackPublication: () => undefined },
        setPttGated,
      } as never);

      pipeline.setPttGated(true);
      pipeline.setPttGated(false);

      expect(setPttGated.mock.calls).toEqual([[true], [false]]);
    });
  });

  describe("teardown", () => {
    // #1728: a context closed before the VAD worklet's final process() call
    // is pinned for the page's lifetime, one per voice join.
    it("closes the context only after the detector's worklet has stopped", async () => {
      FakeAudioContext.workletsLoad = true;
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(true));
      const ctx = contextOf(track);
      const vad = FakeAudioWorkletNode.instances.find((w) => w.name === "vad-processor")!;

      pipeline.teardownAudioPipeline();
      expect(vad.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
      // OC-0231: a gate the worklet posts after the stop is not acted on.
      vad.emit({ type: "gate", gated: true });
      expect(pipeline.isVadGated).toBe(false);
      await Promise.resolve();
      expect(ctx.close).not.toHaveBeenCalled();

      vad.emit({ type: "stopped" });
      await vi.waitFor(() => expect(ctx.close).toHaveBeenCalledTimes(1));
    });
  });

  describe("attach", () => {
    it("applies input volume, sensitivity and the Enhanced NS preference to the new processor", async () => {
      prefs.set("inputVolume", 150);
      prefs.set("voiceSensitivity", 60);
      const pipeline = new AudioPipeline();
      const track = micTrack();

      await pipeline.attach(track);
      const ctx = contextOf(track);
      expect(inputGain(ctx).value).toBe(1.5);
      // The detector fell back to polling (no worklet in jsdom) with the gate's lookahead on.
      await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(false));
      expect(ctx.node("delay").delayTime.value).toBe(0.05);
      expect(pipeline.isActive).toBe(true);
      expect(pipeline.ctxState).toBe("running");
      pipeline.teardownAudioPipeline();
      expect(pipeline.isActive).toBe(false);
    });

    it("is a no-op for a track that already carries this pipeline's processor", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      const setProcessor = vi.spyOn(track, "setProcessor");

      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      pipeline.setupAudioPipeline();

      expect(setProcessor).not.toHaveBeenCalled();
    });

    it("propagates a refused processor so the publish fails instead of going raw", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      vi.spyOn(track, "setProcessor").mockRejectedValue(new Error("refused"));

      await expect(pipeline.attach(track)).rejects.toThrow("refused");
      expect(pipeline.isActive).toBe(false);
    });
  });

  describe("sensitivity", () => {
    it("100 runs no detector and no lookahead; below 100 restarts the detector at the new threshold", async () => {
      prefs.set("voiceSensitivity", 100);
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      const ctx = contextOf(track);
      expect(ctx.node("delay").delayTime.value).toBe(0);
      expect(ctx.audioWorklet.addModule).not.toHaveBeenCalled();

      ctx.audioWorklet.addModule.mockResolvedValue(undefined);
      pipeline.setVoiceSensitivity(30);
      await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(true));

      expect(ctx.node("delay").delayTime.value).toBe(0.05);
      const worklet = FakeAudioWorkletNode.instances[0]!;
      expect(worklet.port.postMessage).toHaveBeenCalledWith({
        type: "config",
        threshold: vadThreshold(30),
      });
      worklet.emit({ type: "gate", gated: true });
      expect(pipeline.isVadGated).toBe(true);
      expect(outputGain(ctx).value).toBe(0);
      worklet.emit({ type: "rms", value: 0.2 });
      expect(pipeline.lastVadRms).toBe(0.2);

      pipeline.setVoiceSensitivity(100);
      expect(pipeline.isVadGated).toBe(false);
      expect(outputGain(ctx).value).toBe(1);
      expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
    });
  });

  describe("local speaking verdict", () => {
    it("reports the sensitivity gate itself, so the ring follows the slider", async () => {
      FakeAudioContext.workletsLoad = true;
      const pipeline = new AudioPipeline();
      const verdicts: Array<boolean | null> = [];
      pipeline.onGateSpeaking = (speaking) => verdicts.push(speaking);
      await pipeline.attach(micTrack());
      await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(true));
      const vad = FakeAudioWorkletNode.instances.find((w) => w.name === "vad-processor")!;
      expect(verdicts.at(-1)).toBe(true);
      verdicts.length = 0;

      vad.emit({ type: "gate", gated: false });
      vad.emit({ type: "gate", gated: true });
      expect(verdicts).toEqual([true, false]);

      // Sensitivity 100 runs no gate: LiveKit decides again.
      pipeline.setVoiceSensitivity(100);
      expect(verdicts.at(-1)).toBeNull();
    });

    it("drives the room's own gate on the slider's scale where the room has no web processor (the native room)", () => {
      prefs.set("voiceSensitivity", 70);
      const pipeline = new AudioPipeline();
      const verdicts: Array<boolean | null> = [];
      pipeline.onGateSpeaking = (speaking) => verdicts.push(speaking);
      const setVoiceGate = vi.fn();
      pipeline.setRoom({
        localParticipant: { getTrackPublication: () => undefined },
        setVoiceGate,
      } as never);

      expect(setVoiceGate).toHaveBeenLastCalledWith(vadThreshold(70), expect.any(Function));
      pipeline.setVoiceSensitivity(40);
      expect(setVoiceGate).toHaveBeenLastCalledWith(vadThreshold(40), expect.any(Function));

      const report = setVoiceGate.mock.calls.at(-1)![1] as (speaking: boolean | null) => void;
      verdicts.length = 0;
      report(false);
      report(true);
      expect(verdicts).toEqual([false, true]);
    });
  });

  describe("reapplyEnhancedNoiseSuppression", () => {
    it("routes the live processor through RNNoise without restarting the capture", async () => {
      FakeAudioContext.workletsLoad = true;
      vi.stubGlobal(
        "fetch",
        // The smallest valid module: createRNNoiseNode now compiles what it fetches.
        vi.fn(async () => ({
          arrayBuffer: async () =>
            new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer,
        })),
      );
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      const restartTrack = vi.spyOn(track, "restartTrack");
      prefs.set("enhancedNoiseSuppression", true);

      const applying = pipeline.reapplyEnhancedNoiseSuppression();
      await vi.waitFor(() => expect(rnnoise()).toBeDefined());
      rnnoise()!.emit({ type: "ready" });
      await applying;

      expect(restartTrack).not.toHaveBeenCalled();
      expect((track.getProcessor() as unknown as MicProcessor).enhanced).toBe(true);
    });

    it("reports RNNoise failing to start", async () => {
      const pipeline = new AudioPipeline();
      await pipeline.attach(micTrack());
      prefs.set("enhancedNoiseSuppression", true);
      const onError = vi.fn();

      await pipeline.reapplyEnhancedNoiseSuppression(onError);

      expect(onError).toHaveBeenCalledWith("Failed to update audio settings");
    });
  });

  describe("reapplyAudioProcessing", () => {
    it("restarts the capture with the saved device and processing, keeping the processor", async () => {
      prefs.set("audioInputDevice", "usb-mic");
      prefs.set("noiseSuppression", false);
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      const restartTrack = vi.spyOn(track, "restartTrack");
      const ctx = contextOf(track);

      await pipeline.reapplyAudioProcessing();

      expect(restartTrack).toHaveBeenCalledWith({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        voiceIsolation: false,
        deviceId: { exact: "usb-mic" },
      });
      expect(contextOf(track)).toBe(ctx);
      expect(ctx.latest("source").track.id).toBe("mic-2");
    });

    it("restarts on the system default while the saved mic is unplugged (DP-31)", async () => {
      prefs.set("audioInputDevice", "usb-mic");
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      const restartTrack = vi
        .spyOn(track, "restartTrack")
        .mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "OverconstrainedError" }));
      const onError = vi.fn();

      await pipeline.reapplyAudioProcessing(onError);

      expect(restartTrack).toHaveBeenLastCalledWith(
        expect.objectContaining({ deviceId: "default", echoCancellation: true }),
      );
      expect(onError).not.toHaveBeenCalled();
    });

    // Owner's report 2026-10-08: an unplugged mic ends the capture and
    // livekit-client's handleTrackEnded restarts it on `{deviceId: "default"}`
    // with no processing flags, so the browser's defaults (AGC on) replace
    // the saved toggles until the next settings change.
    it("re-applies the saved processing after the SDK restarts the capture without it", async () => {
      prefs.set("autoGainControl", false);
      // The browser applies its defaults to any flag a request leaves out.
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async (constraints) => {
        const audio = (constraints as { audio: MediaTrackConstraints }).audio;
        const track = fakeMediaStreamTrack("mic-2");
        track.getSettings = () =>
          ({
            deviceId: "default",
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...audio,
          }) as MediaTrackSettings;
        return new FakeMediaStream([track]) as unknown as MediaStream;
      });
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      const restartTrack = vi.spyOn(track, "restartTrack");

      await track.restartTrack({ deviceId: "default" });

      await vi.waitFor(() => expect(restartTrack).toHaveBeenCalledTimes(2));
      expect(restartTrack).toHaveBeenLastCalledWith(
        expect.objectContaining({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          voiceIsolation: false,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(restartTrack, "the corrected capture is not restarted again").toHaveBeenCalledTimes(2);
    });

    it("reports a failed restart", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      vi.spyOn(track, "restartTrack").mockRejectedValue(new Error("device error"));
      const onError = vi.fn();

      await pipeline.reapplyAudioProcessing(onError);

      expect(onError).toHaveBeenCalledWith("Failed to update audio settings");
    });
  });
});

describe("startVadDetector", () => {
  beforeEach(() => {
    installFakeAudio();
    FakeAudioWorkletNode.instances = [];
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("moves the threshold on the running worklet without restarting it", async () => {
    const ctx = new FakeAudioContext();
    ctx.audioWorklet.addModule.mockResolvedValue(undefined);
    const onGate = vi.fn();
    const detector = startVadDetector(ctx as never, ctx.createAnalyser() as never, 0.05, {
      onGate,
    });
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));

    detector.setThreshold(0.01);

    const worklet = FakeAudioWorkletNode.instances[0]!;
    expect(worklet.port.postMessage).toHaveBeenLastCalledWith({ type: "config", threshold: 0.01 });
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);
    void detector.stop();
    worklet.emit({ type: "gate", gated: true });
    expect(onGate).not.toHaveBeenCalled();
  });

  it("holds the fallback gate for elapsed time, not poll count, when timers are throttled", async () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const analyser = ctx.createAnalyser();
    analyser.getFloatTimeDomainData.mockImplementation((arr: Float32Array) => arr.fill(0));
    const onGate = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, { onGate });
    await vi.advanceTimersByTimeAsync(16 * 30);
    await vi.advanceTimersByTimeAsync(16); // the first quiet poll starts the hold
    expect(onGate).not.toHaveBeenCalled();
    // A hidden window runs the next poll a second later, not 16 ms: it is
    // already past the 320 ms hold.
    vi.setSystemTime(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(16);
    expect(onGate).toHaveBeenLastCalledWith(true);
    void detector.stop();
  });

  it("falls back to polling with the same attack and hold when the worklet is unavailable", async () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const analyser = ctx.createAnalyser();
    let level = 0;
    analyser.getFloatTimeDomainData.mockImplementation((arr: Float32Array) => arr.fill(level));
    const onGate = vi.fn();
    const onStarted = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, {
      onGate,
      onStarted,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStarted).toHaveBeenCalledWith(false);

    // Start-up grace (30 polls) then 320 ms below the threshold (the
    // worklet's hold) close the gate.
    await vi.advanceTimersByTimeAsync(16 * 30);
    expect(onGate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16 * 20);
    expect(onGate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16 * 2);
    expect(onGate).toHaveBeenLastCalledWith(true);

    // A single loud poll is not speech; two are.
    level = 0.2;
    await vi.advanceTimersByTimeAsync(16);
    expect(onGate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16);
    expect(onGate).toHaveBeenLastCalledWith(false);
    void detector.stop();
  });
});
