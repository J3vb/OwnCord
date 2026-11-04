import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/audioPipelineMocks";
import { TrackEvent } from "livekit-client";
import {
  AudioPipeline,
  isMissingDeviceError,
  micCaptureOptions,
  startVadDetector,
} from "../../../src/lib/voice/audioPipeline";
import type { MicProcessor } from "../../../src/lib/voice/micProcessor";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeMediaStream,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../../helpers/fakeAudioContext";
import {
  useAudioPipelineEnv,
  micTrack,
  contextOf,
  inputGain,
  roomWith,
  rnnoise,
} from "../../helpers/audioPipelineHarness";

vi.mock("@lib/prefs/preferences", () => mocks.prefsPreferencesMock());
vi.mock("@lib/logger", () => mocks.loggerMock());

const { prefs, logs } = mocks;

describe("microphone capture request", () => {
  beforeEach(() => prefs.clear());

  it("names no device when none is saved", () => {
    expect(micCaptureOptions()).toStrictEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: false,
    });
  });

  it("asks for the saved device exactly, or for the default while it is unplugged", () => {
    prefs.set("audioInputDevice", "usb-mic");
    expect(micCaptureOptions().deviceId).toEqual({ exact: "usb-mic" });
    expect(micCaptureOptions(true).deviceId).toBe("default");
  });

  it("carries the three saved processing toggles", () => {
    prefs.set("echoCancellation", false);
    prefs.set("noiseSuppression", false);
    prefs.set("autoGainControl", false);
    expect(micCaptureOptions()).toStrictEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      voiceIsolation: false,
    });
  });
});

describe("isMissingDeviceError", () => {
  const named = (name: string): Error => Object.assign(new Error(name), { name });

  it.each([
    ["OverconstrainedError", true],
    ["NotFoundError", true],
    ["NotAllowedError", false],
    ["AbortError", false],
    ["", false],
  ])("a %s for a named device is %s", (name, expected) => {
    expect(isMissingDeviceError(named(name), { deviceId: { exact: "usb" } })).toBe(expected);
  });

  it("is false when the request named no device, whatever the error", () => {
    expect(isMissingDeviceError(named("OverconstrainedError"), {})).toBe(false);
    expect(isMissingDeviceError(named("NotFoundError"), { deviceId: undefined })).toBe(false);
  });

  it("is false for a value that is not an error", () => {
    expect(isMissingDeviceError(null, { deviceId: "x" })).toBe(false);
    expect(isMissingDeviceError(undefined, { deviceId: "x" })).toBe(false);
    expect(isMissingDeviceError("NotFoundError", { deviceId: "x" })).toBe(false);
  });
});

describe("AudioPipeline lifecycle and settings", () => {
  useAudioPipelineEnv();

  const lastContext = (): FakeAudioContext => FakeAudioContext.instances.at(-1)!;

  it("starts with no gate closed and no worklet detector", () => {
    const pipeline = new AudioPipeline();
    expect(pipeline.isVadGated).toBe(false);
    expect(pipeline.isPttGated).toBe(false);
    expect(pipeline.vadUsingWorklet).toBe(false);
  });

  describe("attach", () => {
    it("discards an attach that a teardown overtook, and leaves nothing running", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const setProcessor = vi.spyOn(track, "setProcessor").mockImplementation(() => blocked);
      const attaching = pipeline.attach(track);
      await vi.waitFor(() => expect(setProcessor).toHaveBeenCalled());

      pipeline.teardownAudioPipeline();
      release();
      await attaching;

      expect(pipeline.isActive).toBe(false);
      expect(pipeline.ctxState).toBeNull();
      expect(track.listenerCount(TrackEvent.Restarted)).toBe(0);
      expect(lastContext().audioWorklet.addModule).not.toHaveBeenCalled();
      expect(logs.info).not.toHaveBeenCalledWith("Mic processor attached", expect.anything());
    });

    it("tears the previous processor down when it moves to a new track", async () => {
      const pipeline = new AudioPipeline();
      const first = micTrack();
      await pipeline.attach(first);
      const firstContext = contextOf(first);
      expect(first.listenerCount(TrackEvent.Restarted)).toBe(1);

      const second = micTrack();
      await pipeline.attach(second);

      await vi.waitFor(() => expect(firstContext.close).toHaveBeenCalledTimes(1));
      expect(first.listenerCount(TrackEvent.Restarted)).toBe(0);
      expect(second.listenerCount(TrackEvent.Restarted)).toBe(1);
      expect(contextOf(second).close).not.toHaveBeenCalled();
    });

    it("says which input gain it attached with", async () => {
      prefs.set("inputVolume", 80);
      const pipeline = new AudioPipeline();
      await pipeline.attach(micTrack());
      expect(logs.info).toHaveBeenCalledWith("Mic processor attached", { inputGain: 0.8 });
    });

    it("runs the sensitivity gate when the default push-to-talk probe reports no live key", async () => {
      prefs.set("inputMode", "ptt");
      prefs.set("pttVk", 0x41);
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      expect(contextOf(track).node("delay").delayTime.value).toBe(0.05);
    });
  });

  describe("setupAudioPipeline", () => {
    it("attaches a processor to the room's microphone track", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      pipeline.setRoom(roomWith(track));

      pipeline.setupAudioPipeline();

      await vi.waitFor(() => expect(pipeline.isActive).toBe(true));
      expect(track.getProcessor()).toBeDefined();
    });

    it("moves to a new microphone track when the room's track changed", async () => {
      const pipeline = new AudioPipeline();
      const first = micTrack();
      await pipeline.attach(first);
      const second = micTrack();
      pipeline.setRoom(roomWith(second));

      pipeline.setupAudioPipeline();

      await vi.waitFor(() => expect(second.getProcessor()).toBeDefined());
      expect(pipeline.isActive).toBe(true);
      expect(second.getProcessor()).not.toBe(first.getProcessor());
    });

    it("does nothing without a microphone track", () => {
      const pipeline = new AudioPipeline();
      pipeline.setRoom(roomWith(undefined));
      pipeline.setupAudioPipeline();
      expect(pipeline.isActive).toBe(false);
      expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it("logs a refused processor instead of throwing", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      const refused = new Error("refused");
      vi.spyOn(track, "setProcessor").mockRejectedValue(refused);
      pipeline.setRoom(roomWith(track));

      pipeline.setupAudioPipeline();

      await vi.waitFor(() =>
        expect(logs.warn).toHaveBeenCalledWith("Mic processor attach failed", refused),
      );
      expect(pipeline.isActive).toBe(false);
    });
  });

  describe("input volume", () => {
    it("scales the processor's input gain, saves the percentage and clamps it to 0-200", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);

      pipeline.setInputVolume(50);
      expect(pipeline.inputGain).toBe(0.5);
      expect(inputGain(contextOf(track)).value).toBe(0.5);
      expect(prefs.get("inputVolume")).toBe(50);

      pipeline.setInputVolume(999);
      expect(pipeline.inputGain).toBe(2);
      expect(prefs.get("inputVolume")).toBe(200);

      pipeline.setInputVolume(-5);
      expect(pipeline.inputGain).toBe(0);
      expect(inputGain(contextOf(track)).value).toBe(0);
    });
  });

  describe("voice sensitivity", () => {
    it("restarts the detector only when the value changes, and saves it", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      const addModule = contextOf(track).audioWorklet.addModule;
      const before = addModule.mock.calls.length;

      pipeline.setVoiceSensitivity(30);
      expect(addModule).toHaveBeenCalledTimes(before + 1);
      expect(prefs.get("voiceSensitivity")).toBe(30);
      pipeline.setVoiceSensitivity(30);
      expect(addModule).toHaveBeenCalledTimes(before + 1);
      pipeline.setVoiceSensitivity(31);
      expect(addModule).toHaveBeenCalledTimes(before + 2);
      expect(logs.debug).toHaveBeenCalledWith("Voice sensitivity updated", { sensitivity: 31 });
    });

    it("clamps to 0-100", async () => {
      const pipeline = new AudioPipeline();
      pipeline.setVoiceSensitivity(250);
      expect(prefs.get("voiceSensitivity")).toBe(100);
      pipeline.setVoiceSensitivity(-4);
      expect(prefs.get("voiceSensitivity")).toBe(0);
    });

    it("takes the lookahead back off and reports no worklet once the gate is switched off", async () => {
      FakeAudioContext.workletsLoad = true;
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(true));
      const ctx = contextOf(track);
      expect(ctx.node("delay").delayTime.value).toBe(0.05);

      pipeline.setVoiceSensitivity(100);

      expect(ctx.node("delay").delayTime.value).toBe(0);
      expect(pipeline.vadUsingWorklet).toBe(false);
      expect(pipeline.lastVadRms).toBe(0);
    });
  });

  describe("reapplyAudioProcessing", () => {
    it("does nothing, and says so, without a voice session", async () => {
      const pipeline = new AudioPipeline();
      const onError = vi.fn();
      await pipeline.reapplyAudioProcessing(onError);
      expect(logs.debug).toHaveBeenCalledWith(
        "Skipping audio processing reapply — no active voice session",
      );
      expect(onError).not.toHaveBeenCalled();
    });

    it("does nothing, and says so, when the room has no microphone track", async () => {
      const pipeline = new AudioPipeline();
      pipeline.setRoom(roomWith(undefined));
      await pipeline.reapplyAudioProcessing();
      expect(logs.debug).toHaveBeenCalledWith("Skipping audio processing reapply — no mic track");
      expect(logs.debug).not.toHaveBeenCalledWith(
        "Skipping audio processing reapply — no active voice session",
      );
    });

    it("surfaces an error that is not a missing device without retrying on the default", async () => {
      prefs.set("audioInputDevice", "usb-mic");
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      const failure = Object.assign(new Error("denied"), { name: "NotAllowedError" });
      const restartTrack = vi.spyOn(track, "restartTrack").mockRejectedValueOnce(failure);
      const onError = vi.fn();

      await pipeline.reapplyAudioProcessing(onError);

      expect(restartTrack).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("Failed to update audio settings");
      expect(logs.error).toHaveBeenCalledWith("Failed to reapply audio processing", failure);
    });

    it("logs the request it restarted with", async () => {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      await pipeline.reapplyAudioProcessing();
      expect(logs.info).toHaveBeenCalledWith(
        "Audio processing reapplied via restartTrack",
        expect.objectContaining({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          voiceIsolation: false,
        }),
      );
    });
  });

  describe("a room that applies the processing toggles itself", () => {
    it("passes each saved toggle under its own key, and leaves a web track alone", async () => {
      prefs.set("echoCancellation", true);
      prefs.set("noiseSuppression", false);
      prefs.set("autoGainControl", true);
      prefs.set("enhancedNoiseSuppression", false);
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      const setAudioProcessing = vi.fn();
      pipeline.setRoom({
        localParticipant: (roomWith(track) as { localParticipant: unknown }).localParticipant,
        setAudioProcessing,
      } as never);
      const restartTrack = vi.spyOn(track, "restartTrack");
      const setEnhanced = vi.spyOn(track.getProcessor() as unknown as MicProcessor, "setEnhanced");

      await pipeline.reapplyAudioProcessing();
      await pipeline.reapplyEnhancedNoiseSuppression();

      expect(setAudioProcessing).toHaveBeenCalledTimes(2);
      expect(setAudioProcessing).toHaveBeenLastCalledWith({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        enhancedNoiseSuppression: false,
      });
      expect(restartTrack).not.toHaveBeenCalled();
      expect(setEnhanced).not.toHaveBeenCalled();
    });
  });

  describe("reapplyEnhancedNoiseSuppression errors", () => {
    it("does not report a failure when Enhanced Noise Suppression is off", async () => {
      const pipeline = new AudioPipeline();
      await pipeline.attach(micTrack());
      const onError = vi.fn();
      await pipeline.reapplyEnhancedNoiseSuppression(onError);
      expect(onError).not.toHaveBeenCalled();
    });

    it("does not report a failure when RNNoise starts", async () => {
      FakeAudioContext.workletsLoad = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
      );
      const pipeline = new AudioPipeline();
      await pipeline.attach(micTrack());
      prefs.set("enhancedNoiseSuppression", true);
      const onError = vi.fn();

      const applying = pipeline.reapplyEnhancedNoiseSuppression(onError);
      await vi.waitFor(() => expect(rnnoise()).toBeDefined());
      rnnoise()!.emit({ type: "ready" });
      await applying;

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("a capture the SDK restarted on its own", () => {
    /** The browser applies `applied` on top of the request, as for a real capture. */
    function browserApplies(applied: Record<string, unknown>): void {
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async (constraints) => {
        const audio = (constraints as { audio: MediaTrackConstraints }).audio;
        const track = fakeMediaStreamTrack("mic-2");
        track.getSettings = () => ({ deviceId: "default", ...audio, ...applied }) as never;
        return new FakeMediaStream([track]) as unknown as MediaStream;
      });
    }
    const saved = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: false,
    };

    async function attached() {
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      pipeline.setRoom(roomWith(track));
      const restartTrack = vi.spyOn(track, "restartTrack");
      return { pipeline, track, restartTrack };
    }

    it("leaves a capture that already has the saved processing alone", async () => {
      browserApplies(saved);
      const { track, restartTrack } = await attached();

      await track.restartTrack({ deviceId: "default" });
      await new Promise((r) => setTimeout(r, 0));

      expect(restartTrack).toHaveBeenCalledTimes(1);
      expect(logs.info).not.toHaveBeenCalledWith(
        expect.stringContaining("reapplying"),
        expect.anything(),
      );
    });

    it("names the processing flags that drifted when it reapplies", async () => {
      prefs.set("autoGainControl", false);
      prefs.set("echoCancellation", false);
      // The browser reports defaults for flags the SDK's request leaves out.
      browserApplies({ ...saved, echoCancellation: true, autoGainControl: true });
      const { track, restartTrack } = await attached();

      await track.restartTrack({ deviceId: "default" });

      await vi.waitFor(() => expect(restartTrack).toHaveBeenCalledTimes(2));
      expect(logs.info).toHaveBeenCalledWith(
        "Mic capture restarted without the saved processing — reapplying",
        { drifted: ["echoCancellation", "autoGainControl"] },
      );
    });

    it("corrects one drift once, even though its own restart is a restart too", async () => {
      prefs.set("autoGainControl", false);
      // The browser ignores the request: the corrected capture still differs.
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () => {
        const track = fakeMediaStreamTrack("mic-2");
        track.getSettings = () => ({ deviceId: "default", ...saved });
        return new FakeMediaStream([track]) as unknown as MediaStream;
      });
      const { track, restartTrack } = await attached();

      await track.restartTrack({ deviceId: "default" });
      await vi.waitFor(() => expect(restartTrack).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 20));

      expect(restartTrack).toHaveBeenCalledTimes(2);
    });

    it("corrects each later drifted restart too, once the earlier correction is done", async () => {
      prefs.set("autoGainControl", false);
      browserApplies({ ...saved, autoGainControl: true });
      // After a correction the browser honours the saved flags.
      const { track, restartTrack } = await attached();
      vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async (constraints) => {
        const audio = (constraints as { audio: MediaTrackConstraints }).audio;
        const mic = fakeMediaStreamTrack("mic-2");
        const defaulted = audio.autoGainControl === undefined;
        mic.getSettings = () =>
          ({
            deviceId: "default",
            ...saved,
            ...audio,
            ...(defaulted ? { autoGainControl: true } : {}),
          }) as never;
        return new FakeMediaStream([mic]) as unknown as MediaStream;
      });

      await track.restartTrack({ deviceId: "default" });
      await vi.waitFor(() => expect(restartTrack).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 0));

      await track.restartTrack({ deviceId: "default" });
      await vi.waitFor(() => expect(restartTrack).toHaveBeenCalledTimes(4));
    });
  });
});

describe("startVadDetector details", () => {
  beforeEach(() => {
    for (const fn of Object.values(logs)) fn.mockClear();
    installFakeAudio();
    FakeAudioWorkletNode.instances = [];
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function worklets() {
    const ctx = new FakeAudioContext();
    ctx.audioWorklet.addModule.mockResolvedValue(undefined);
    const analyser = ctx.createAnalyser();
    return { ctx, analyser };
  }

  it("loads the detector worklet from the public assets", async () => {
    const { ctx, analyser } = worklets();
    startVadDetector(ctx as never, analyser as never, 0.05, { onGate: vi.fn() });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith("/vad-worklet.js");
  });

  it("feeds the analyser into the worklet and reports it started with its threshold", async () => {
    const { ctx, analyser } = worklets();
    const onStarted = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, {
      onGate: vi.fn(),
      onStarted,
    });
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    const worklet = FakeAudioWorkletNode.instances[0]!;

    expect(worklet.name).toBe("vad-processor");
    expect(analyser.outputs).toContain(worklet);
    expect(onStarted).toHaveBeenCalledWith(true);
    expect(logs.info).toHaveBeenCalledWith("VAD AudioWorklet started", { threshold: 0.05 });
    void detector.stop();
  });

  it("passes gate and level messages on and ignores any other message", async () => {
    const { ctx, analyser } = worklets();
    const onGate = vi.fn();
    const onRms = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, { onGate, onRms });
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    const worklet = FakeAudioWorkletNode.instances[0]!;

    worklet.emit({ type: "gate", gated: true });
    worklet.emit({ type: "rms", value: 0.02 });
    worklet.emit({ type: "something-else", value: 0.5, gated: true });

    expect(onGate.mock.calls).toEqual([[true]]);
    expect(onRms.mock.calls).toEqual([[0.02]]);
    void detector.stop();
  });

  it("disconnects the worklet when stopped", async () => {
    const { ctx, analyser } = worklets();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, { onGate: vi.fn() });
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    const worklet = FakeAudioWorkletNode.instances[0]!;

    void detector.stop();

    expect(worklet.disconnect).toHaveBeenCalledTimes(1);
    expect(worklet.port.postMessage).toHaveBeenLastCalledWith({ type: "stop" });
  });

  it("builds no worklet when stopped before the module loaded", async () => {
    const { ctx, analyser } = worklets();
    const onStarted = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, {
      onGate: vi.fn(),
      onStarted,
    });

    await detector.stop();
    await new Promise((r) => setTimeout(r, 0));

    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(analyser.outputs).toHaveLength(0);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("starts no polling when stopped before the module failed to load", async () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const analyser = ctx.createAnalyser();
    const onStarted = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, {
      onGate: vi.fn(),
      onStarted,
    });

    await detector.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onStarted).not.toHaveBeenCalled();
    expect(analyser.getFloatTimeDomainData).not.toHaveBeenCalled();
  });

  it("polls instead, and logs why, when the worklet node cannot be created", async () => {
    vi.useFakeTimers();
    const failure = new Error("construct failed");
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        constructor() {
          throw failure;
        }
      },
    );
    const { ctx, analyser } = worklets();
    const onStarted = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, 0.05, {
      onGate: vi.fn(),
      onStarted,
    });
    await vi.advanceTimersByTimeAsync(16);

    expect(onStarted.mock.calls).toEqual([[false]]);
    expect(logs.warn).toHaveBeenCalledWith(
      "Failed to create VAD AudioWorkletNode, falling back",
      failure,
    );
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalled();
    void detector.stop();
  });

  it("logs why it polls when the worklet module is unavailable", async () => {
    vi.useFakeTimers();
    const ctx = new FakeAudioContext();
    const failure = new Error("no worklet");
    ctx.audioWorklet.addModule.mockRejectedValue(failure);
    const detector = startVadDetector(ctx as never, ctx.createAnalyser() as never, 0.05, {
      onGate: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.warn).toHaveBeenCalledWith(
      "AudioWorklet unavailable, falling back to setTimeout VAD",
      failure,
    );
    expect(logs.info).toHaveBeenCalledWith("VAD setTimeout fallback started", { threshold: 0.05 });
    void detector.stop();
  });

  describe("polling", () => {
    async function polling(level: number, gate: number | "auto" = 0.05) {
      vi.useFakeTimers();
      const ctx = new FakeAudioContext();
      const analyser = ctx.createAnalyser();
      const state = { level };
      analyser.getFloatTimeDomainData.mockImplementation((arr: Float32Array) =>
        arr.fill(state.level),
      );
      const handlers = { onGate: vi.fn(), onRms: vi.fn(), onThreshold: vi.fn() };
      const detector = startVadDetector(ctx as never, analyser as never, gate, handlers);
      await vi.advanceTimersByTimeAsync(0);
      return { state, analyser, detector, ...handlers };
    }

    it("reports a level on every third poll", async () => {
      const { onRms, detector } = await polling(0.02);
      await vi.advanceTimersByTimeAsync(16 * 8);
      expect(onRms).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(16);
      expect(onRms).toHaveBeenCalledTimes(3);
      expect(onRms.mock.calls[0]![0]).toBeCloseTo(0.02, 6);
      void detector.stop();
    });

    it("closes the gate on the poll where the quiet has lasted exactly the hold", async () => {
      const { onGate, detector } = await polling(0);
      // 30 polls of start-up grace, then the first quiet poll starts the hold.
      await vi.advanceTimersByTimeAsync(16 * 62);
      expect(onGate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(16);
      expect(onGate.mock.calls).toEqual([[true]]);
      void detector.stop();
    });

    it("counts a level equal to the threshold as speech", async () => {
      const { onGate, detector } = await polling(0.5, 0.5);
      await vi.advanceTimersByTimeAsync(16 * 100);
      expect(onGate).not.toHaveBeenCalled();
      void detector.stop();
    });

    it("counts a level just under the threshold as quiet", async () => {
      const { onGate, detector } = await polling(0.25, 0.5);
      await vi.advanceTimersByTimeAsync(16 * 100);
      expect(onGate).toHaveBeenCalledWith(true);
      void detector.stop();
    });

    it("stops polling when a handler stops the detector from inside a poll", async () => {
      vi.useFakeTimers();
      const ctx = new FakeAudioContext();
      const analyser = ctx.createAnalyser();
      let detector: ReturnType<typeof startVadDetector> | null = null;
      const onGate = vi.fn(() => {
        void detector?.stop();
      });
      detector = startVadDetector(ctx as never, analyser as never, 0.05, { onGate });
      await vi.advanceTimersByTimeAsync(16 * 70);
      expect(onGate).toHaveBeenCalledTimes(1);
      const polls = analyser.getFloatTimeDomainData.mock.calls.length;

      await vi.advanceTimersByTimeAsync(16 * 20);

      expect(analyser.getFloatTimeDomainData.mock.calls.length).toBe(polls);
    });

    it("learns the noise floor after a switch from a fixed threshold to automatic", async () => {
      const { detector, onThreshold, onGate } = await polling(0.003, 0.05);
      detector.setThreshold("auto");
      await vi.advanceTimersByTimeAsync(3000);
      expect(onThreshold).toHaveBeenLastCalledWith(expect.closeTo(0.003 * 10 ** 0.5, 6));
      expect(onGate).toHaveBeenLastCalledWith(true);
      void detector.stop();
    });
  });

  it("forgets the learned floor when asked, then follows the new room level", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { ctx, analyser } = worklets();
    const onThreshold = vi.fn();
    const detector = startVadDetector(ctx as never, analyser as never, "auto", {
      onGate: vi.fn(),
      onThreshold,
    });
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    const worklet = FakeAudioWorkletNode.instances[0]!;

    worklet.emit({ type: "rms", value: 0.001 });
    vi.advanceTimersByTime(1100);
    worklet.emit({ type: "rms", value: 0.001 });
    expect(onThreshold).toHaveBeenLastCalledWith(expect.closeTo(0.001 * 10 ** 0.5, 6));

    // The input volume went up: the room now reads ten times louder.
    detector.resetFloor();
    vi.advanceTimersByTime(300);
    worklet.emit({ type: "rms", value: 0.01 });
    vi.advanceTimersByTime(1100);
    worklet.emit({ type: "rms", value: 0.01 });

    expect(onThreshold).toHaveBeenLastCalledWith(expect.closeTo(0.01 * 10 ** 0.5, 6));
    void detector.stop();
  });
});
