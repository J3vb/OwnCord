import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/audioPipelineMocks";
import { AUTO_MAX_THRESHOLD } from "../../../src/lib/voice/noiseFloor";
import {
  AudioPipeline,
  startVadDetector,
  vadThreshold,
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
  outputGain,
  roomWith,
  rnnoise,
} from "../../helpers/audioPipelineHarness";

vi.mock("@lib/prefs/preferences", () => mocks.prefsPreferencesMock());
vi.mock("@lib/logger", () => mocks.loggerMock());

const { prefs } = mocks;

describe("AudioPipeline", () => {
  useAudioPipelineEnv();

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

    it("a restart keeps RNNoise's verdict running; no gate (100) turns it off", async () => {
      prefs.set("voiceSensitivity", 100);
      const pipeline = new AudioPipeline();
      const track = micTrack();
      await pipeline.attach(track);
      contextOf(track).audioWorklet.addModule.mockResolvedValue(undefined);
      const processor = track.getProcessor() as unknown as MicProcessor;
      const detection = vi.spyOn(processor, "setSpeechDetection");
      pipeline.setVoiceSensitivity(30);
      await vi.waitFor(() => expect(detection).toHaveBeenCalledWith(true));
      detection.mockClear();

      pipeline.setVoiceSensitivity(40);
      await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(2));
      await vi.waitFor(() => expect(detection).toHaveBeenCalledWith(true));
      expect(detection).not.toHaveBeenCalledWith(false);

      pipeline.setVoiceSensitivity(100);
      expect(detection).toHaveBeenLastCalledWith(false);
    });
  });

  describe("input mode", () => {
    let pttLive = false;
    const setPttPollingLive = (live: boolean): void => {
      pttLive = live;
    };
    afterEach(() => setPttPollingLive(false));

    it("a live Push to Talk key runs no sensitivity gate; Voice Activity restarts it", async () => {
      prefs.set("voiceSensitivity", 30);
      prefs.set("inputMode", "ptt");
      prefs.set("pttVk", 0x41);
      setPttPollingLive(true);
      const pipeline = new AudioPipeline(() => pttLive);
      const track = micTrack();
      await pipeline.attach(track);
      const ctx = contextOf(track);
      expect(ctx.node("delay").delayTime.value).toBe(0);
      expect(ctx.audioWorklet.addModule).not.toHaveBeenCalled();

      ctx.audioWorklet.addModule.mockResolvedValue(undefined);
      prefs.set("inputMode", "vad");
      pipeline.applyInputMode();
      await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(true));
      const worklet = FakeAudioWorkletNode.instances[0]!;
      expect(worklet.port.postMessage).toHaveBeenCalledWith({
        type: "config",
        threshold: vadThreshold(30),
      });
      worklet.emit({ type: "gate", gated: true });
      expect(outputGain(ctx).value).toBe(0);

      prefs.set("inputMode", "ptt");
      pipeline.applyInputMode();
      expect(pipeline.isVadGated).toBe(false);
      expect(outputGain(ctx).value).toBe(1);
      expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
    });

    it("keeps the sensitivity gate in Push to Talk mode until a key can gate the mic", () => {
      prefs.set("voiceSensitivity", 70);
      prefs.set("inputMode", "ptt");
      const pipeline = new AudioPipeline(() => pttLive);
      const setVoiceGate = vi.fn();
      const room = { localParticipant: { getTrackPublication: () => undefined }, setVoiceGate };

      // No key bound: nothing else gates, so the sensitivity still does.
      setPttPollingLive(true);
      pipeline.setRoom(room as never);
      expect(setVoiceGate).toHaveBeenLastCalledWith(
        vadThreshold(70),
        expect.any(Function),
        expect.any(Object),
      );

      // Key bound, but this host cannot report key state (macOS, Wayland).
      prefs.set("pttVk", 0x41);
      setPttPollingLive(false);
      pipeline.applyInputMode();
      expect(setVoiceGate).toHaveBeenLastCalledWith(
        vadThreshold(70),
        expect.any(Function),
        expect.any(Object),
      );

      // The poller goes live: Push to Talk takes over.
      setPttPollingLive(true);
      pipeline.applyInputMode();
      expect(setVoiceGate).toHaveBeenLastCalledWith(0, expect.any(Function), expect.any(Object));
    });
  });

  describe("automatic sensitivity", () => {
    it("runs the detector on the noise floor and seeds a restarted one from it", async () => {
      vi.useFakeTimers({ toFake: ["performance"] });
      try {
        prefs.set("autoInputSensitivity", true);
        FakeAudioContext.workletsLoad = true;
        const pipeline = new AudioPipeline();
        const track = micTrack();
        await pipeline.attach(track);
        await vi.waitFor(() => expect(pipeline.vadUsingWorklet).toBe(true));
        const first = FakeAudioWorkletNode.instances.find((w) => w.name === "vad-processor")!;
        expect(first.port.postMessage).toHaveBeenCalledWith({
          type: "config",
          threshold: AUTO_MAX_THRESHOLD,
        });

        // A second of a -60 dBFS room moves the gate 10 dB above it.
        first.emit({ type: "rms", value: 0.001 });
        vi.advanceTimersByTime(1100);
        first.emit({ type: "rms", value: 0.001 });
        const reached = 0.001 * 10 ** 0.5;
        const moved = first.port.postMessage.mock.calls.at(-1)![0] as {
          type: string;
          threshold: number;
        };
        expect(moved.type).toBe("threshold");
        expect(moved.threshold).toBeCloseTo(reached, 9);

        // Switching modes restarts the detector: it starts where the last left off.
        pipeline.applyInputMode();
        await vi.waitFor(() =>
          expect(
            FakeAudioWorkletNode.instances.filter((w) => w.name === "vad-processor"),
          ).toHaveLength(2),
        );
        const second = FakeAudioWorkletNode.instances.filter((w) => w.name === "vad-processor")[1]!;
        await vi.waitFor(() => expect(second.port.postMessage).toHaveBeenCalled());
        const config = second.port.postMessage.mock.calls[0]![0] as {
          type: string;
          threshold: number;
        };
        expect(config.type).toBe("config");
        expect(config.threshold).toBeCloseTo(reached, 9);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs no gate while a live Push to Talk key gates, automatic or not", async () => {
      prefs.set("autoInputSensitivity", true);
      prefs.set("inputMode", "ptt");
      prefs.set("pttVk", 0x41);
      const pipeline = new AudioPipeline(() => true);
      const track = micTrack();
      await pipeline.attach(track);
      const ctx = contextOf(track);
      expect(ctx.node("delay").delayTime.value).toBe(0);
      expect(ctx.audioWorklet.addModule).not.toHaveBeenCalled();
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

      expect(setVoiceGate).toHaveBeenLastCalledWith(
        vadThreshold(70),
        expect.any(Function),
        expect.any(Object),
      );
      pipeline.setVoiceSensitivity(40);
      expect(setVoiceGate).toHaveBeenLastCalledWith(
        vadThreshold(40),
        expect.any(Function),
        expect.any(Object),
      );

      const report = setVoiceGate.mock.calls.at(-1)![1] as (speaking: boolean | null) => void;
      verdicts.length = 0;
      report(false);
      report(true);
      expect(verdicts).toEqual([false, true]);
    });

    it("hands automatic sensitivity to the room's own gate, seeded and fed back like the detector's", () => {
      prefs.set("autoInputSensitivity", true);
      const pipeline = new AudioPipeline();
      const setVoiceGate = vi.fn();
      const room = { localParticipant: { getTrackPublication: () => undefined }, setVoiceGate };
      pipeline.setRoom(room as never);
      expect(setVoiceGate).toHaveBeenLastCalledWith("auto", expect.any(Function), {
        seed: undefined,
        onThreshold: expect.any(Function),
      });
      // The room's estimate seeds the next gate, as a restarted detector's.
      const auto = setVoiceGate.mock.calls.at(-1)![2] as { onThreshold: (t: number) => void };
      auto.onThreshold(0.004);
      pipeline.applyInputMode();
      expect(setVoiceGate).toHaveBeenLastCalledWith(
        "auto",
        expect.any(Function),
        expect.objectContaining({ seed: 0.004 }),
      );
    });

    it("gives the room's own capture the input volume and passes its level reports on", () => {
      prefs.set("inputVolume", 150);
      const pipeline = new AudioPipeline();
      const setInputGain = vi.fn();
      const setInputLevelListener = vi.fn();
      const room = {
        localParticipant: { getTrackPublication: () => undefined },
        setVoiceGate: vi.fn(),
        setInputGain,
        setInputLevelListener,
      };
      const levels: Array<[number | null, boolean]> = [];
      const unsubscribe = pipeline.onRoomInputLevel((rms, open) => levels.push([rms, open]));
      pipeline.setRoom(room as never);
      expect(setInputGain).toHaveBeenLastCalledWith(150);

      pipeline.setInputVolume(250);
      expect(setInputGain).toHaveBeenLastCalledWith(200);

      const report = setInputLevelListener.mock.calls.at(-1)![0] as (
        rms: number,
        open: boolean,
      ) => void;
      report(0.02, true);
      unsubscribe();
      report(0.03, false);
      expect(levels).toEqual([[0.02, true]]);

      // A room left behind stops reporting into the pipeline.
      pipeline.setRoom(null);
      expect(setInputLevelListener).toHaveBeenLastCalledWith(null);
    });

    it("ends the meter when the room is let go before its capture says it stopped", () => {
      const pipeline = new AudioPipeline();
      const room = {
        localParticipant: { getTrackPublication: () => undefined },
        setVoiceGate: vi.fn(),
        setInputGain: vi.fn(),
        setInputLevelListener: vi.fn(),
      };
      const levels: Array<[number | null, boolean]> = [];
      pipeline.onRoomInputLevel((rms, open) => levels.push([rms, open]));
      pipeline.setRoom(null);
      expect(levels).toEqual([]);
      pipeline.setRoom(room as never);
      pipeline.setRoom(null);
      expect(levels).toEqual([[null, false]]);
    });
  });

  describe("a room that applies the processing toggles itself", () => {
    const nativeRoom = () => ({
      localParticipant: { getTrackPublication: () => undefined },
      setVoiceGate: vi.fn(),
      setAudioProcessing: vi.fn(),
    });

    it("gets the four saved toggles from reapplyAudioProcessing, without a track restart", async () => {
      prefs.set("echoCancellation", false);
      prefs.set("noiseSuppression", true);
      prefs.set("autoGainControl", false);
      prefs.set("enhancedNoiseSuppression", true);
      const pipeline = new AudioPipeline();
      const room = nativeRoom();
      pipeline.setRoom(room as never);
      const onError = vi.fn();
      await pipeline.reapplyAudioProcessing(onError);
      expect(room.setAudioProcessing).toHaveBeenCalledExactlyOnceWith({
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
        enhancedNoiseSuppression: true,
      });
      expect(onError).not.toHaveBeenCalled();
    });

    it("gets them from reapplyEnhancedNoiseSuppression too, with defaults for unset prefs", async () => {
      const pipeline = new AudioPipeline();
      const room = nativeRoom();
      pipeline.setRoom(room as never);
      await pipeline.reapplyEnhancedNoiseSuppression();
      expect(room.setAudioProcessing).toHaveBeenCalledExactlyOnceWith({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        enhancedNoiseSuppression: false,
      });
    });
  });

  describe("reapplyEnhancedNoiseSuppression", () => {
    it("routes the live processor through RNNoise without restarting the capture", async () => {
      FakeAudioContext.workletsLoad = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
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

    it("restarts on the system default while the saved mic is unplugged", async () => {
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

  describe("RNNoise's verdict", () => {
    function speechDetection(answer: (on: boolean) => Promise<boolean>) {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      const setOn = vi.fn(answer);
      return { source, setOn, detection: { source: source as never, setOn } };
    }
    /** A detector with RNNoise's verdict wired in, once its worklet is up. */
    async function startDetector(
      detection: ReturnType<typeof speechDetection>["detection"],
      gate: number | "auto" = "auto",
    ) {
      const ctx = new FakeAudioContext();
      ctx.audioWorklet.addModule.mockResolvedValue(undefined);
      const detector = startVadDetector(
        ctx as never,
        ctx.createAnalyser() as never,
        gate,
        { onGate: vi.fn() },
        undefined,
        detection,
      );
      await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
      return detector;
    }

    const speechGateMessages = (worklet: FakeAudioWorkletNode) =>
      worklet.port.postMessage.mock.calls
        .map(([m]) => m as { type: string; on?: boolean })
        .filter((m) => m.type === "speechGate")
        .map((m) => m.on);

    it("feeds the worklet's second input and keeps the rule on across automatic and slider thresholds", async () => {
      const { source, setOn, detection } = speechDetection(async (on) => on);
      const detector = await startDetector(detection);
      const worklet = FakeAudioWorkletNode.instances[0]!;
      expect(source.connect).toHaveBeenCalledWith(worklet, 0, 1);
      await vi.waitFor(() => expect(speechGateMessages(worklet)).toEqual([true]));

      detector.setThreshold(0.05);
      detector.setThreshold("auto");
      expect(speechGateMessages(worklet)).toEqual([true]);
      expect(setOn.mock.calls).toEqual([[true]]);
      // Stopping leaves RNNoise to the processor's owner: a restart's
      // detector asks for it again at once.
      void detector.stop();
      expect(setOn.mock.calls).toEqual([[true]]);
    });

    it("turns the rule on at the slider's threshold too", async () => {
      const { setOn, detection } = speechDetection(async (on) => on);
      const detector = await startDetector(detection, 0.02);
      const worklet = FakeAudioWorkletNode.instances[0]!;
      await vi.waitFor(() => expect(speechGateMessages(worklet)).toEqual([true]));
      expect(setOn).toHaveBeenCalledWith(true);
      void detector.stop();
    });

    it("leaves the gate on its level when RNNoise does not start", async () => {
      const { setOn, detection } = speechDetection(async () => false);
      const detector = await startDetector(detection, 0.02);
      await vi.waitFor(() => expect(setOn).toHaveBeenCalledWith(true));
      await Promise.resolve();
      expect(speechGateMessages(FakeAudioWorkletNode.instances[0]!)).toEqual([]);
      void detector.stop();
    });

    it("does not turn the rule on when RNNoise answers after a stop", async () => {
      const answers: Array<(on: boolean) => void> = [];
      const { detection } = speechDetection(
        (on) => new Promise<boolean>((resolve) => answers.push(() => resolve(on))),
      );
      const detector = await startDetector(detection, 0.02);
      const worklet = FakeAudioWorkletNode.instances[0]!;
      expect(answers).toHaveLength(1);

      void detector.stop();
      answers[0]!(true);
      await Promise.resolve();
      expect(speechGateMessages(worklet)).toEqual([]);
    });
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
    // already past the 500 ms hold.
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

    // Start-up grace (30 polls) then 500 ms below the threshold (the
    // worklet's hold) close the gate.
    await vi.advanceTimersByTimeAsync(16 * 30);
    expect(onGate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16 * 31);
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

  describe("automatic threshold (fallback path)", () => {
    /** A detector over a constant level the test can change. */
    async function autoDetector() {
      vi.useFakeTimers();
      const ctx = new FakeAudioContext();
      const analyser = ctx.createAnalyser();
      const state = { level: 0.003 };
      analyser.getFloatTimeDomainData.mockImplementation((arr: Float32Array) =>
        arr.fill(state.level),
      );
      const onGate = vi.fn();
      const onThreshold = vi.fn();
      const detector = startVadDetector(ctx as never, analyser as never, "auto", {
        onGate,
        onThreshold,
      });
      await vi.advanceTimersByTimeAsync(0);
      return { state, onGate, onThreshold, detector };
    }

    it("does not learn the floor from the start-up grace", async () => {
      const { state, onThreshold, detector } = await autoDetector();
      // The capture settles at a far lower level than the room.
      state.level = 0.0001;
      await vi.advanceTimersByTimeAsync(16 * 28);
      state.level = 0.003;
      await vi.advanceTimersByTimeAsync(3000);
      for (const [threshold] of onThreshold.mock.calls) {
        expect(threshold).toBeGreaterThan(0.003);
      }
      expect(onThreshold).toHaveBeenLastCalledWith(expect.closeTo(0.003 * 10 ** 0.5, 6));
      void detector.stop();
    });

    it("steady noise closes the gate once the floor is learned", async () => {
      // Steady noise at ~-50 dBFS, which the 0.05 manual default would also close on.
      const { onGate, onThreshold, detector } = await autoDetector();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onGate).toHaveBeenLastCalledWith(true);
      expect(onThreshold).toHaveBeenLastCalledWith(expect.closeTo(0.003 * 10 ** 0.5, 6));
      void detector.stop();
    });

    it("speech above the learned floor opens it", async () => {
      const { state, onGate, detector } = await autoDetector();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onGate).toHaveBeenLastCalledWith(true);
      // -34 dBFS: under the 0.05 default, above 10 dB over the floor.
      state.level = 0.02;
      await vi.advanceTimersByTimeAsync(64);
      expect(onGate).toHaveBeenLastCalledWith(false);
      void detector.stop();
    });

    it("rising noise opens the gate, then closes it again once the floor catches up", async () => {
      const { state, onGate, detector } = await autoDetector();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onGate).toHaveBeenLastCalledWith(true);
      // A fan starts at the level speech had above: it opens the gate at
      // first, and the learned floor shuts it again within the window.
      state.level = 0.02;
      await vi.advanceTimersByTimeAsync(500);
      expect(onGate).toHaveBeenLastCalledWith(false);
      await vi.advanceTimersByTimeAsync(10000);
      expect(onGate).toHaveBeenLastCalledWith(true);
      void detector.stop();
    });
  });
});
