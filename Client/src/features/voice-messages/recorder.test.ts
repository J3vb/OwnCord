import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyserLevel,
  blobBytes,
  FakeAudioContext,
  FakeMediaRecorder,
  FakeStream,
  resetFakes,
} from "../../../tests/helpers/voiceFakes";
import {
  MAX_DURATION_MS,
  createVoiceRecorder,
  FLUSH_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  VoiceRecordError,
  type RecorderEnv,
} from "./recorder";
import { decodeWaveform } from "./waveform";

let clock = 0;
let stream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn>;

function env(overrides: Partial<RecorderEnv> = {}): RecorderEnv {
  return {
    getUserMedia: getUserMedia as unknown as RecorderEnv["getUserMedia"],
    MediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
    AudioContext: FakeAudioContext as unknown as typeof AudioContext,
    now: () => clock,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFakes();
  clock = 0;
  stream = new FakeStream();
  getUserMedia = vi.fn(async () => stream);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("voice recorder", () => {
  it("records a webm/opus clip with duration, waveform and a named file", async () => {
    const levels: number[] = [];
    const rec = createVoiceRecorder({ env: env(), onLevel: (p) => levels.push(p) });
    await rec.start();
    expect(rec.state).toBe("recording");
    analyserLevel.value = 0.25;
    await vi.advanceTimersByTimeAsync(300);
    clock = 3_000;
    const clip = await rec.stop();
    expect(clip).not.toBeNull();
    expect(clip?.mime).toBe("audio/webm;codecs=opus");
    expect(clip?.filename).toBe("voice-message.webm");
    expect(clip?.durationMs).toBe(3_000);
    const bars = decodeWaveform(clip?.waveform ?? "");
    expect(bars).toHaveLength(64);
    expect(Math.max(...(bars ?? []))).toBe(255);
    expect(levels.length).toBeGreaterThanOrEqual(3);
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("asks for the picked input device with echo cancellation and noise suppression", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("mic-7"));
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints;
    const audio = constraints.audio as MediaTrackConstraints;
    expect(audio.deviceId).toEqual({ exact: "mic-7" });
    expect(audio.echoCancellation).toBe(true);
    expect(audio.noiseSuppression).toBe(true);
    rec.cancel();
    localStorage.clear();
  });

  it("discards a recording under one second and still releases the microphone", async () => {
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    clock = 999;
    expect(await rec.stop()).toBeNull();
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("stops every track and closes the context on cancel", async () => {
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    rec.cancel();
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
  });

  it("stops every track and closes the context on dispose", async () => {
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    rec.dispose();
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    expect(rec.state).toBe("done");
  });

  it("releases a stream that arrives after the recording was cancelled", async () => {
    const gate: { grant?: (s: FakeStream) => void } = {};
    getUserMedia = vi.fn(() => new Promise<FakeStream>((resolve) => (gate.grant = resolve)));
    const rec = createVoiceRecorder({ env: env() });
    const started = rec.start();
    rec.cancel();
    gate.grant?.(stream);
    await expect(started).rejects.toMatchObject({ kind: "cancelled" });
    expect(stream.allStopped).toBe(true);
  });

  it("reports a denied microphone and an absent one", async () => {
    getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    });
    await expect(createVoiceRecorder({ env: env() }).start()).rejects.toBeInstanceOf(
      VoiceRecordError,
    );
    await expect(createVoiceRecorder({ env: env() }).start()).rejects.toMatchObject({
      kind: "denied",
    });
    getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("none"), { name: "NotFoundError" });
    });
    await expect(createVoiceRecorder({ env: env() }).start()).rejects.toMatchObject({
      kind: "no-device",
    });
  });

  it("falls back to the default device when the picked one is gone", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("gone"));
    getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { name: "OverconstrainedError" }))
      .mockResolvedValueOnce(stream);
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    const retry = getUserMedia.mock.calls[1]?.[0] as { audio: MediaTrackConstraints } | undefined;
    expect(retry?.audio.deviceId).toBeUndefined();
    rec.cancel();
    localStorage.clear();
  });

  it("stops itself at five minutes and hands the clip to onLimit", async () => {
    const onLimit = vi.fn();
    const rec = createVoiceRecorder({ env: env(), onLimit });
    await rec.start();
    clock = MAX_DURATION_MS + 5_000;
    await vi.advanceTimersByTimeAsync(MAX_DURATION_MS);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit.mock.calls[0]?.[0]?.durationMs).toBe(MAX_DURATION_MS);
    expect(stream.allStopped).toBe(true);
  });

  it("captures PCM as a 16 kHz WAV when MediaRecorder is missing", async () => {
    const rec = createVoiceRecorder({ env: env({ MediaRecorder: undefined }) });
    await rec.start();
    const ctx = FakeAudioContext.instances[0];
    const process = ctx?.scriptProcessor?.onaudioprocess;
    expect(process).toBeTypeOf("function");
    for (let i = 0; i < 12; i++) {
      process?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } });
    }
    clock = 2_000;
    const clip = await rec.stop();
    expect(clip?.mime).toBe("audio/wav");
    expect(clip?.filename).toBe("voice-message.wav");
    vi.useRealTimers();
    const bytes = await blobBytes(clip!.blob);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(stream.allStopped).toBe(true);
  });

  it("falls back to PCM when MediaRecorder supports no container", async () => {
    FakeMediaRecorder.supported = [];
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    const process = FakeAudioContext.instances[0]?.scriptProcessor?.onaudioprocess;
    for (let i = 0; i < 18; i++) {
      process?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    }
    clock = 1_500;
    const clip = await rec.stop();
    expect(clip?.mime).toBe("audio/wav");
  });

  it("records without live levels when the AudioContext cannot be built", async () => {
    class BrokenContext extends FakeAudioContext {
      override createMediaStreamSource(): never {
        throw new Error("no source");
      }
    }
    const onLevel = vi.fn();
    const rec = createVoiceRecorder({
      env: env({ AudioContext: BrokenContext as unknown as typeof AudioContext }),
      onLevel,
    });
    await rec.start();
    await vi.advanceTimersByTimeAsync(300);
    clock = 2_000;
    const clip = await rec.stop();
    expect(clip?.mime).toBe("audio/webm;codecs=opus");
    // A flat, low waveform rather than an empty or failed clip.
    expect(Array.from(decodeWaveform(clip?.waveform ?? "") ?? [])).toEqual(
      Array.from({ length: 64 }, () => 32),
    );
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("fails clearly, not with silence, when the PCM context stays suspended", async () => {
    class SuspendedContext extends FakeAudioContext {
      override state: AudioContextState = "suspended";
    }
    const rec = createVoiceRecorder({
      env: env({
        MediaRecorder: undefined,
        AudioContext: SuspendedContext as unknown as typeof AudioContext,
      }),
    });
    await expect(rec.start()).rejects.toMatchObject({ kind: "suspended" });
    expect(stream.allStopped).toBe(true);
  });

  it("takes the PCM clip's length from the samples captured", async () => {
    const rec = createVoiceRecorder({ env: env({ MediaRecorder: undefined }) });
    await rec.start();
    const process = FakeAudioContext.instances[0]?.scriptProcessor?.onaudioprocess;
    for (let i = 0; i < 24; i++) {
      process?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } });
    }
    clock = 60_000; // the wall clock says a minute; only 2.05 s of audio arrived
    const clip = await rec.stop();
    expect(clip?.durationMs).toBe(Math.round((24 * 4096 * 1000) / 48_000));
  });

  it("gives up cleanly when MediaRecorder never fires stop", async () => {
    const rec = createVoiceRecorder({ env: env() });
    await rec.start();
    const mr = FakeMediaRecorder.instances[0]!;
    mr.stop = (): void => {
      mr.state = "inactive";
    };
    clock = 2_000;
    const pending = rec.stop();
    const settled = expect(pending).rejects.toMatchObject({ kind: "failed" });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await settled;
    expect(stream.allStopped).toBe(true);
    expect(rec.state).toBe("done");
  });

  it("drops the recording and reports it when the microphone is unplugged", async () => {
    const onDeviceLost = vi.fn();
    const rec = createVoiceRecorder({ env: env(), onDeviceLost });
    await rec.start();
    stream.tracks[0]?.dispatchEvent(new Event("ended"));
    expect(onDeviceLost).toHaveBeenCalledTimes(1);
    expect(rec.state).toBe("done");
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  describe("worklet capture", () => {
    class FakePort extends EventTarget {
      sent: unknown[] = [];
      reply = true;
      start(): void {}
      postMessage(message: { type: string }): void {
        this.sent.push(message);
        if (message.type === "flush" && this.reply) {
          queueMicrotask(() => {
            this.emit(new Float32Array(48_000).fill(0.1)); // the partial tail
            this.emit({ type: "flushed" });
          });
        }
      }
      emit(data: unknown): void {
        this.dispatchEvent(Object.assign(new Event("message"), { data }));
      }
    }
    const ports: FakePort[] = [];
    class WorkletContext extends FakeAudioContext {
      override audioWorklet = { addModule: vi.fn(async () => {}) } as never;
    }
    class FakeWorkletNode {
      port = new FakePort();
      constructor() {
        ports.push(this.port);
      }
      connect = vi.fn();
      disconnect = vi.fn();
    }

    beforeEach(() => {
      ports.length = 0;
      vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const workletEnv = (): RecorderEnv =>
      env({
        MediaRecorder: undefined,
        AudioContext: WorkletContext as unknown as typeof AudioContext,
      });

    it("asks the worklet for its partial block and keeps the tail", async () => {
      const rec = createVoiceRecorder({ env: workletEnv() });
      await rec.start();
      ports[0]?.emit(new Float32Array(48_000).fill(0.1)); // one second of 48 kHz
      clock = 2_000;
      const clip = await rec.stop();
      expect(ports[0]?.sent).toEqual([{ type: "flush" }]);
      vi.useRealTimers();
      const bytes = await blobBytes(clip!.blob);
      // Two seconds at 16 kHz mono 16-bit: the block plus the flushed tail.
      expect(bytes.length).toBe(44 + 2 * 16_000 * 2);
      expect(stream.allStopped).toBe(true);
    });

    it("stops anyway when the worklet never answers", async () => {
      const rec = createVoiceRecorder({ env: workletEnv() });
      await rec.start();
      ports[0]!.reply = false;
      ports[0]?.emit(new Float32Array(48_000));
      clock = 2_000;
      const pending = rec.stop();
      await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS);
      const clip = await pending;
      expect(clip?.mime).toBe("audio/wav");
      expect(stream.allStopped).toBe(true);
    });
  });
});
