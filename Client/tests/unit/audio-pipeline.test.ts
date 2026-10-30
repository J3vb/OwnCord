import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAudioTrack, Track, TrackEvent } from "livekit-client";
import {
  AudioPipeline,
  isMissingDeviceError,
  micCaptureOptions,
  startVadDetector,
  vadThreshold,
} from "../../src/lib/voice/audioPipeline";
import type { MicProcessor } from "../../src/lib/voice/micProcessor";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeMediaStream,
  fakeMediaStreamTrack,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@lib/prefs/preferences", () => ({
  loadPref: (key: string, fallback: unknown) => (prefs.has(key) ? prefs.get(key) : fallback),
  savePref: (key: string, value: unknown) => prefs.set(key, value),
}));
const logs = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@lib/logger", () => ({ createLogger: () => logs }));

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
    for (const fn of Object.values(logs)) fn.mockClear();
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
          threshold: vadThreshold(50),
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
  beforeEach(() => {
    prefs.clear();
    for (const fn of Object.values(logs)) fn.mockClear();
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
      await vi.advanceTimersByTimeAsync(16 * 50);
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
      await vi.advanceTimersByTimeAsync(16 * 60);
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
