/**
 * WP M-8: the "App sounds volume" master gain and the per-sound switches on the
 * player side. The sounds themselves are unchanged: at 100% every note keeps
 * the gain it always had and a master gain of exactly 1 sits in front of them.
 *
 * Preferences are the real ones (jsdom localStorage), so what the settings
 * slider saves is what the player reads. Where each trigger consults its
 * switch is app-sounds-gates.test.ts's; the settings controls are
 * app-sounds-settings.test.ts's.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  cleanupNotificationAudio,
  playNotificationSound,
  playVoiceSound,
  startRingChime,
  startRingback,
  stopRingback,
  stopRingChime,
} from "@lib/notificationSound";
import { loadAppSoundsGain, soundSwitchOn } from "@lib/prefs/soundPrefs";
import { savePref } from "@lib/prefs/preferences";

interface FakeGain {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
}

class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];
  readonly currentTime = 0;
  readonly destination = { kind: "destination" };
  readonly oscillators: Array<{ hz: number[]; stop: ReturnType<typeof vi.fn> }> = [];
  readonly gains: FakeGain[] = [];
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
      frequency: { setValueAtTime: (hz: number) => osc.hz.push(hz) },
    };
    this.oscillators.push(osc);
    return osc;
  }

  createGain(): FakeGain {
    const node: FakeGain = {
      connect: vi.fn(),
      gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    };
    this.gains.push(node);
    return node;
  }
}

/** The one context's master gain: the first gain node, which connects to the
 *  destination (every per-note gain connects to it instead). */
function master(ctx: RecordingAudioContext): FakeGain {
  const node = ctx.gains.find((g) => g.connect.mock.calls.some(([to]) => to === ctx.destination));
  if (node === undefined) throw new Error("no master gain connected to the destination");
  return node;
}

beforeEach(() => {
  localStorage.clear();
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", RecordingAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  stopRingChime();
  stopRingback();
  cleanupNotificationAudio();
  vi.unstubAllGlobals();
});

describe("app sounds volume prefs", () => {
  it("defaults to 100% (a gain of 1)", () => {
    expect(loadAppSoundsGain()).toBe(1);
  });

  it("reads the saved percent as a gain", () => {
    savePref("appSoundsVolume", 40);
    expect(loadAppSoundsGain()).toBeCloseTo(0.4);
    savePref("appSoundsVolume", 0);
    expect(loadAppSoundsGain()).toBe(0);
  });

  it("reads a stored value outside 0-100 as the nearest end, never above today's level", () => {
    savePref("appSoundsVolume", 250);
    expect(loadAppSoundsGain()).toBe(1);
    savePref("appSoundsVolume", -30);
    expect(loadAppSoundsGain()).toBe(0);
  });

  it("reads a corrupt stored value as 100% rather than silencing the app", () => {
    localStorage.setItem("owncord:settings:appSoundsVolume", JSON.stringify("loud"));
    expect(loadAppSoundsGain()).toBe(1);
    localStorage.setItem("owncord:settings:appSoundsVolume", "{not json");
    expect(loadAppSoundsGain()).toBe(1);
  });

  it("reads a stored value too large to be a number as 100%, never as silence", () => {
    localStorage.setItem("owncord:settings:appSoundsVolume", "-1e999");
    expect(loadAppSoundsGain()).toBe(1);
    localStorage.setItem("owncord:settings:appSoundsVolume", "1e999");
    expect(loadAppSoundsGain()).toBe(1);
  });

  it("has every per-sound switch on until the user turns it off", () => {
    expect(soundSwitchOn("message")).toBe(true);
    savePref("soundMessage", false);
    expect(soundSwitchOn("message")).toBe(false);
    expect(soundSwitchOn("mention")).toBe(true);
  });
});

describe("the master gain", () => {
  it("leaves today's notes alone at 100%", () => {
    playNotificationSound();
    const ctx = RecordingAudioContext.instances[0]!;

    expect(master(ctx).gain.value).toBe(1);
    const note = ctx.gains.find((g) => g !== master(ctx))!;
    expect(note.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0);
    expect(note.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.01, 0.2);
    expect(ctx.oscillators[0]!.hz).toEqual([800, 600]);
  });

  it("routes every note through the master, not straight to the output", () => {
    playNotificationSound();
    playVoiceSound("join");
    const ctx = RecordingAudioContext.instances[0]!;
    const m = master(ctx);

    for (const g of ctx.gains) {
      if (g === m) continue;
      expect(g.connect).toHaveBeenCalledWith(m);
      expect(g.connect).not.toHaveBeenCalledWith(ctx.destination);
    }
  });

  it("applies the saved percent to the master only", () => {
    savePref("appSoundsVolume", 35);
    playVoiceSound("streamStart");
    const ctx = RecordingAudioContext.instances[0]!;

    expect(master(ctx).gain.value).toBeCloseTo(0.35);
    const notes = ctx.gains.filter((g) => g !== master(ctx));
    expect(notes).toHaveLength(3);
    for (const n of notes)
      expect(n.gain.setValueAtTime).toHaveBeenCalledWith(0.2, expect.any(Number));
  });

  it("is silent at 0%", () => {
    savePref("appSoundsVolume", 0);
    playNotificationSound();

    expect(master(RecordingAudioContext.instances[0]!).gain.value).toBe(0);
  });

  it("follows a slider move on the very next sound, on the same master", () => {
    playNotificationSound();
    const ctx = RecordingAudioContext.instances[0]!;
    const m = master(ctx);
    expect(m.gain.value).toBe(1);

    savePref("appSoundsVolume", 20);
    playNotificationSound();

    expect(master(ctx)).toBe(m);
    expect(m.gain.value).toBeCloseTo(0.2);
  });
});

describe("one AudioContext", () => {
  it("serves every kind of sound from a single context and a single master", () => {
    playNotificationSound();
    playVoiceSound("mute");
    playVoiceSound("moved");
    startRingChime();
    startRingback();
    stopRingChime();

    expect(RecordingAudioContext.instances).toHaveLength(1);
    const ctx = RecordingAudioContext.instances[0]!;
    const toDestination = ctx.gains.filter((g) =>
      g.connect.mock.calls.some(([to]) => to === ctx.destination),
    );
    expect(toDestination).toHaveLength(1);
  });

  it("builds a fresh master with a fresh context after cleanup", () => {
    playNotificationSound();
    cleanupNotificationAudio();
    savePref("appSoundsVolume", 50);
    playNotificationSound();

    expect(RecordingAudioContext.instances).toHaveLength(2);
    expect(master(RecordingAudioContext.instances[1]!).gain.value).toBeCloseTo(0.5);
  });
});

describe("the call sounds' own switches", () => {
  it("rings nothing when the ring switch is off, though the group switch is on", () => {
    savePref("soundRing", false);

    startRingChime();

    expect(RecordingAudioContext.instances).toHaveLength(0);
  });

  it("still rings with the ring switch on", () => {
    startRingChime();

    expect(RecordingAudioContext.instances[0]!.oscillators).toHaveLength(2);
  });

  it("stops a ring in flight when its switch is turned off mid-ring", () => {
    vi.useFakeTimers();
    startRingChime();
    const ctx = RecordingAudioContext.instances[0]!;
    vi.advanceTimersByTime(2000);
    expect(ctx.oscillators).toHaveLength(4);

    savePref("soundRing", false);
    vi.advanceTimersByTime(2000);
    expect(ctx.oscillators).toHaveLength(4);
    expect(ctx.oscillators[3]!.stop).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(ctx.oscillators).toHaveLength(4);
  });

  it("keeps the ringback off while its own switch is off, ring switch notwithstanding", () => {
    savePref("soundRingback", false);

    startRingback();

    expect(RecordingAudioContext.instances).toHaveLength(0);
  });

  it("keeps the ringback going through an incoming ring that its switch silences", () => {
    vi.useFakeTimers();
    savePref("soundRing", false);
    startRingback();
    const ctx = RecordingAudioContext.instances[0]!;
    const before = ctx.oscillators.length;

    startRingChime();
    stopRingChime();
    vi.advanceTimersByTime(3000);

    expect(ctx.oscillators.length).toBeGreaterThan(before);
  });

  it("stops a ringback in flight when its switch is turned off mid-ring, and resumes on", () => {
    vi.useFakeTimers();
    startRingback();
    const ctx = RecordingAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(1);

    savePref("soundRingback", false);
    expect(ctx.oscillators[0]!.stop).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(ctx.oscillators).toHaveLength(1);

    savePref("soundRingback", true);
    expect(ctx.oscillators).toHaveLength(2);
  });
});
