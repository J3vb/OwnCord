import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../helpers/log-capture";
import type { NativeMicTestEnvelope } from "../../src/platform/contracts/nativeVoice";

const startMicTest = vi.fn();
const stopMicTest = vi.fn();
const unsubscribe = vi.fn();
let handler: ((envelope: NativeMicTestEnvelope) => void) | null = null;

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    nativeVoice: {
      startMicTest: (...args: unknown[]) => startMicTest(...args) as unknown,
      stopMicTest: (...args: unknown[]) => stopMicTest(...args) as unknown,
      onMicTestEvent: (h: typeof handler) => {
        handler = h;
        return unsubscribe;
      },
    },
  },
}));

import { PROBE_WINDOW_MS, probeNativeMicrophone } from "../../src/features/voice/native/micProbe";

const level = (test: number, rms = 0.1): void =>
  handler?.({ test, event: { type: "inputLevel", rms, open: true } });

describe("native microphone probe", () => {
  let ac: AbortController;
  beforeEach(() => {
    vi.useFakeTimers();
    ac = new AbortController();
    handler = null;
    startMicTest.mockReset().mockResolvedValue(4);
    stopMicTest.mockReset().mockResolvedValue(undefined);
    unsubscribe.mockReset();
  });
  afterEach(() => {
    ac.abort();
    vi.useRealTimers();
  });

  it("opens a capture-only test on the chosen device and passes when levels arrive", async () => {
    const probe = probeNativeMicrophone("alsa:usb", ac.signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(startMicTest).toHaveBeenCalledWith(
      expect.objectContaining({ input: "alsa:usb", output: "", monitor: true, outputGain: 0 }),
    );
    level(4);
    level(9);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await expect(probe).resolves.toBe("levels");
    expect(stopMicTest).toHaveBeenCalledWith(4);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports silence when the device opened but only another test reported", async () => {
    const probe = probeNativeMicrophone("", ac.signal);
    await vi.advanceTimersByTimeAsync(1);
    level(9);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await expect(probe).resolves.toBe("silent");
    expect(stopMicTest).toHaveBeenCalledWith(4);
  });

  it("reports silence when a muted source reports only zero levels", async () => {
    const probe = probeNativeMicrophone("", ac.signal);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 10; i++) level(4, 0);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await expect(probe).resolves.toBe("silent");
  });

  it("passes a quiet but live microphone", async () => {
    const probe = probeNativeMicrophone("", ac.signal);
    await vi.advanceTimersByTimeAsync(1);
    level(4, 0);
    level(4, 0.0004);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await expect(probe).resolves.toBe("levels");
  });

  it("counts a level that arrived before the start resolved", async () => {
    let resolveStart!: (id: number) => void;
    startMicTest.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const probe = probeNativeMicrophone("", ac.signal);
    await vi.advanceTimersByTimeAsync(1);
    level(4);
    resolveStart(4);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await expect(probe).resolves.toBe("levels");
  });

  it("reports a call that holds the capture", async () => {
    startMicTest.mockRejectedValue(new Error("mic test unavailable during a call"));
    await expect(probeNativeMicrophone("", ac.signal)).resolves.toBe("in-call");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects when the device cannot open", async () => {
    startMicTest.mockRejectedValue(new Error("no input device"));
    await expect(probeNativeMicrophone("", ac.signal)).rejects.toThrow("no input device");
    expect(stopMicTest).not.toHaveBeenCalled();
  });

  it("stops the capture when cancelled during the window", async () => {
    const probe = probeNativeMicrophone("", ac.signal);
    const settled = probe.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS / 2);
    ac.abort(new DOMException("cancelled", "AbortError"));
    expect(await settled).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopMicTest).toHaveBeenCalledWith(4);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("stops a capture still opening when cancelled, as soon as it resolves", async () => {
    let resolveStart!: (id: number) => void;
    startMicTest.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const probe = probeNativeMicrophone("", ac.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1);
    ac.abort(new DOMException("closed", "AbortError"));
    expect(await probe).toMatchObject({ name: "AbortError" });
    expect(stopMicTest).not.toHaveBeenCalled();
    resolveStart(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopMicTest).toHaveBeenCalledWith(8);
  });

  it("does not start when already cancelled", async () => {
    ac.abort(new DOMException("cancelled", "AbortError"));
    await expect(probeNativeMicrophone("", ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(startMicTest).not.toHaveBeenCalled();
  });

  it("opens the capture with every audio processing option off", async () => {
    const probe = probeNativeMicrophone("", ac.signal);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await probe;
    expect(startMicTest).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          enhancedNoiseSuppression: false,
        },
      }),
    );
  });

  it("listens for cancellation once", async () => {
    const add = vi.spyOn(ac.signal, "addEventListener");
    const probe = probeNativeMicrophone("", ac.signal);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    await probe;
    const aborts = add.mock.calls.filter(([type]) => type === "abort");
    expect(aborts.length).toBeGreaterThan(0);
    for (const [, , options] of aborts) expect(options).toMatchObject({ once: true });
  });

  it("leaves no unhandled rejection when the start throws and the signal is cancelled later", async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      startMicTest.mockImplementation(() => {
        throw new Error("bridge down");
      });
      await expect(probeNativeMicrophone("", ac.signal)).rejects.toThrow("bridge down");
      ac.abort(new Error("late cancel"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("logs that there was nothing to stop when the start failed", async () => {
    const logs = captureLogs();
    startMicTest.mockRejectedValue(new Error("no input device"));
    await expect(probeNativeMicrophone("", ac.signal)).rejects.toThrow("no input device");
    await vi.advanceTimersByTimeAsync(1);
    const entries = logs.find("The microphone probe left nothing to stop");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.component).toBe("micProbe");
    expect(entries[0]?.data).toMatchObject({ error: "no input device" });
  });
});
