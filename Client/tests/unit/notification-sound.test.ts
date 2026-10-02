/**
 * DP-40: the app's notification and voice sounds ignore the deafen state, and
 * they play on the system default output regardless of the device chosen in
 * settings. These pin both: a deafened player stays silent, and the shared
 * AudioContext's sink is the saved output and follows a device change.
 *
 * The voice-edge subscriber that decides *when* a sound plays is
 * voice-ui-sounds.test.ts's.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanupNotificationAudio, playNotificationSound } from "@lib/notificationSound";
import { setLocalDeafened } from "@stores/voice.store";

class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];
  readonly currentTime = 0;
  readonly destination = {};
  readonly setSinkId = vi.fn(async () => {});
  readonly oscillators: Array<{ hz: number[] }> = [];
  readonly close = vi.fn(async () => {});

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  createOscillator() {
    const osc = {
      hz: [] as number[],
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      frequency: {
        setValueAtTime: (hz: number) => osc.hz.push(hz),
      },
    };
    this.oscillators.push(osc);
    return osc;
  }

  createGain() {
    return {
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    };
  }
}

const { testPrefs } = vi.hoisted(() => ({ testPrefs: new Map<string, unknown>() }));

vi.mock("../../src/lib/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

beforeEach(() => {
  testPrefs.clear();
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", RecordingAudioContext);
  setLocalDeafened(false);
});

afterEach(() => {
  cleanupNotificationAudio();
  vi.unstubAllGlobals();
});

describe("playNotificationSound and deafen", () => {
  it("produces no oscillator while locally deafened", () => {
    setLocalDeafened(true);

    playNotificationSound();

    expect(RecordingAudioContext.instances).toHaveLength(0);
  });

  it("plays normally once undeafened", () => {
    playNotificationSound();

    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(RecordingAudioContext.instances[0]!.oscillators).toHaveLength(1);
  });
});

describe("the shared AudioContext sink", () => {
  it("is set to the saved output device when the context is created", () => {
    testPrefs.set("audioOutputDevice", "speakers-a");

    playNotificationSound();

    const ctx = RecordingAudioContext.instances[0]!;
    expect(ctx.setSinkId).toHaveBeenCalledWith("speakers-a");
  });

  it("stays on the default when no output device is saved", () => {
    playNotificationSound();

    expect(RecordingAudioContext.instances[0]!.setSinkId).not.toHaveBeenCalled();
  });

  it("follows a device change", () => {
    testPrefs.set("audioOutputDevice", "speakers-a");
    playNotificationSound();
    const ctx = RecordingAudioContext.instances[0]!;

    testPrefs.set("audioOutputDevice", "headphones-b");
    playNotificationSound();

    expect(ctx.setSinkId).toHaveBeenLastCalledWith("headphones-b");
  });

  it("does not re-issue setSinkId for an unchanged device", () => {
    testPrefs.set("audioOutputDevice", "speakers-a");
    playNotificationSound();
    playNotificationSound();

    expect(RecordingAudioContext.instances[0]!.setSinkId).toHaveBeenCalledTimes(1);
  });
});
