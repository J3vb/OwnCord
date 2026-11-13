/**
 * The sound style: "modern" (the default) or "classic", today's plain tones.
 * Every spec of both styles must fit what the Linux host accepts, a mention
 * and a message sound different in Modern only, and a style switch or a cut
 * ring burst never leaves a note or an interval behind. Preferences are the
 * real ones; the native host and the platform check are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const host = vi.hoisted(() => ({
  linux: false,
  playSound: vi.fn(),
  stopSound: vi.fn(),
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    nativeVoice: { playSound: host.playSound, stopSound: host.stopSound },
    notifier: {},
  },
}));
vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => host.linux,
  isWindowsDesktop: () => false,
}));

import {
  cleanupNotificationAudio,
  playNotificationSound,
  startRingChime,
  startRingback,
  stopRingback,
  stopRingChime,
} from "@lib/media/notificationSound";
import { REPEAT_MS, soundSpec, type AppSound, type ToneSpec } from "@lib/media/soundTables";
import { loadSoundStyle } from "@lib/prefs/soundPrefs";
import { savePref } from "@lib/prefs/preferences";
import { RecordingAudioContext, recordedOscillators } from "../helpers/audioContextMock";

const oscillators = recordedOscillators;
/** The frequency points of a spec, note by note, as the oscillators see them. */
const pitches = (spec: ToneSpec): number[][] => spec.map((n) => n.freqs.map(([, hz]) => hz));

const SOUNDS: readonly AppSound[] = [
  "message",
  "mention",
  "ring",
  "ringback",
  "join",
  "leave",
  "moved",
  "mute",
  "unmute",
  "deafen",
  "undeafen",
  "streamStart",
  "streamEnd",
  "viewerJoin",
  "viewerLeave",
];
const STYLES = ["modern", "classic"] as const;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", RecordingAudioContext);
  host.linux = false;
  host.playSound.mockReset().mockResolvedValue(1);
  host.stopSound.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  stopRingChime();
  stopRingback();
  cleanupNotificationAudio();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sound style pref", () => {
  it("is modern until the user picks classic", () => {
    expect(loadSoundStyle()).toBe("modern");
    savePref("soundStyle", "classic");
    expect(loadSoundStyle()).toBe("classic");
    savePref("soundStyle", "modern");
    expect(loadSoundStyle()).toBe("modern");
  });

  it("reads a bad stored value as modern", () => {
    for (const raw of [JSON.stringify("retro"), "42", "{not json", JSON.stringify(null)]) {
      localStorage.setItem("owncord:settings:soundStyle", raw);
      expect(loadSoundStyle(), raw).toBe("modern");
    }
  });
});

describe("every spec fits the Linux host's limits", () => {
  const nyquist = 24_000;
  const inUnit = (v: number): boolean => Number.isFinite(v) && v > 0 && v <= 1;

  it.each(STYLES.flatMap((style) => SOUNDS.map((sound) => [style, sound] as const)))(
    "%s %s",
    (style, sound) => {
      const spec = soundSpec(style, sound);
      expect(spec.length).toBeGreaterThanOrEqual(1);
      expect(spec.length).toBeLessThanOrEqual(32);
      let end = 0;
      for (const n of spec) {
        const attack = n.attack ?? 0;
        const release = n.release ?? 0;
        expect(Number.isFinite(n.at) && n.at >= 0).toBe(true);
        expect(Number.isFinite(n.duration) && n.duration > 0).toBe(true);
        expect(inUnit(n.gain), `gain ${n.gain}`).toBe(true);
        expect(inUnit(n.endGain), `endGain ${n.endGain}`).toBe(true);
        expect(Number.isFinite(attack) && attack >= 0 && attack < n.duration).toBe(true);
        expect(Number.isFinite(release) && release >= 0).toBe(true);
        expect(n.freqs.length).toBeGreaterThanOrEqual(1);
        expect(n.freqs.length).toBeLessThanOrEqual(8);
        n.freqs.forEach(([offset, hz], i) => {
          expect(Number.isFinite(offset) && offset >= 0).toBe(true);
          expect(Number.isFinite(hz) && hz > 0 && hz < nyquist).toBe(true);
          if (i > 0) expect(offset).toBeGreaterThanOrEqual(n.freqs[i - 1]![0]);
        });
        end = Math.max(end, n.at + n.duration + release);
      }
      expect(end).toBeLessThanOrEqual(2);
    },
  );
});

describe("the tables", () => {
  const plain = (at: number, duration: number, gain: number, hz: number) => ({
    at,
    duration,
    gain,
    endGain: 0.01,
    freqs: [[0, hz]],
  });

  it("keeps the classic sounds exactly as OwnCord played them before", () => {
    const chime = [
      {
        ...plain(0, 0.2, 0.3, 800),
        freqs: [
          [0, 800],
          [0.1, 600],
        ],
      },
    ];
    expect(soundSpec("classic", "message")).toEqual(chime);
    expect(soundSpec("classic", "mention")).toEqual(chime);
    expect(soundSpec("classic", "ring")).toEqual([
      plain(0, 0.16, 0.25, 660),
      plain(0.18, 0.16, 0.25, 880),
    ]);
    expect(soundSpec("classic", "ringback")).toEqual([plain(0, 0.5, 0.12, 440)]);
    expect(soundSpec("classic", "join")).toEqual([
      plain(0, 0.12, 0.2, 523),
      plain(0.09, 0.12, 0.2, 784),
    ]);
    expect(soundSpec("classic", "viewerLeave")).toEqual([
      plain(0, 0.12, 0.1, 880),
      plain(0.07, 0.12, 0.1, 659),
    ]);
    expect(soundSpec("classic", "streamEnd").map((n) => n.freqs[0]![1])).toEqual([880, 587, 440]);
    for (const sound of SOUNDS) {
      for (const n of soundSpec("classic", sound)) {
        expect(n).not.toHaveProperty("attack");
        expect(n).not.toHaveProperty("release");
        expect(n).not.toHaveProperty("glide");
      }
    }
  });

  it("makes the modern message a gliding bubble and the mention a two-note glass chime", () => {
    const bubble = { endGain: 0.42 * 0.001, attack: 0.004, release: 0.008, glide: true };
    expect(soundSpec("modern", "message")).toEqual([
      {
        at: 0,
        duration: 0.16,
        gain: 0.42,
        ...bubble,
        freqs: [
          [0, 420],
          [0.07, 860],
        ],
      },
      {
        at: 0,
        duration: 0.1,
        gain: 0.42 * 0.22,
        ...bubble,
        endGain: 0.42 * 0.22 * 0.001,
        freqs: [
          [0, 840],
          [0.07, 1720],
        ],
      },
    ]);
    const mention = soundSpec("modern", "mention");
    expect(mention).toHaveLength(8);
    expect(mention[0]).toEqual({
      at: 0,
      duration: 0.3,
      gain: 0.236,
      endGain: 0.236 * 0.001,
      attack: 0.002,
      release: 0.01,
      freqs: [[0, 783.99]],
    });
    expect(mention[4]!.at).toBe(0.11);
    expect(mention[4]!.freqs).toEqual([[0, 1174.66]]);
  });

  it("builds the modern ring from seven mallet notes, under 1.6 s with its release", () => {
    const ring = soundSpec("modern", "ring");
    expect(ring).toHaveLength(28);
    expect(Math.max(...ring.map((n) => n.at + n.duration + (n.release ?? 0)))).toBeCloseTo(
      0.84 + 0.75 + 0.008,
      9,
    );
  });

  it("repeats the ring every 2.8 s in modern and 2 s in classic, the ringback every 3 s", () => {
    expect(REPEAT_MS).toEqual({
      modern: { ring: 2800, ringback: 3000 },
      classic: { ring: 2000, ringback: 3000 },
    });
  });
});

describe("mention and message sounds", () => {
  it("are different sounds in modern", () => {
    playNotificationSound(false);
    expect(oscillators().map((o) => o.hz)).toEqual(pitches(soundSpec("modern", "message")));

    RecordingAudioContext.instances[0]!.oscillators.length = 0;
    playNotificationSound(true);
    expect(oscillators().map((o) => o.hz)).toEqual(pitches(soundSpec("modern", "mention")));
  });

  it("are both the old chime in classic", () => {
    savePref("soundStyle", "classic");
    playNotificationSound(false);
    playNotificationSound(true);
    expect(oscillators().map((o) => o.hz)).toEqual([
      [800, 600],
      [800, 600],
    ]);
  });

  it("follow a style change on the very next sound", () => {
    playNotificationSound();
    savePref("soundStyle", "classic");
    playNotificationSound();
    expect(oscillators()).toHaveLength(soundSpec("modern", "message").length + 1);
    expect(oscillators().at(-1)!.hz).toEqual([800, 600]);
  });
});

describe("a ring burst cut mid-phrase", () => {
  it("stops every partial of every note at once on Web Audio", () => {
    vi.useFakeTimers();
    startRingChime();
    vi.advanceTimersByTime(800);
    const burst = oscillators();
    expect(burst).toHaveLength(soundSpec("modern", "ring").length);
    for (const o of burst) o.stop.mockClear();

    stopRingChime();

    for (const o of burst) expect(o.stop).toHaveBeenCalledWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the whole phrase natively, even when the stop beats the host's id", async () => {
    host.linux = true;
    let answer: (id: number | null) => void = () => {};
    host.playSound.mockReturnValue(
      new Promise<number | null>((resolve) => {
        answer = resolve;
      }),
    );
    startRingChime();
    // One host sound carries the whole phrase, every partial of every note.
    expect(host.playSound.mock.calls[0]![0]).toEqual(soundSpec("modern", "ring"));

    stopRingChime();
    answer(11);
    await settle();

    expect(host.stopSound).toHaveBeenCalledTimes(1);
    expect(host.stopSound).toHaveBeenCalledWith(11);
    expect(RecordingAudioContext.instances).toHaveLength(0);
  });
});

describe("a style switch while sounds are in flight", () => {
  it("lets the ring keep its period, plays the next burst in the new style, and leaks nothing", () => {
    vi.useFakeTimers();
    startRingChime();
    const modern = soundSpec("modern", "ring").length;
    expect(oscillators()).toHaveLength(modern);

    savePref("soundStyle", "classic");
    vi.advanceTimersByTime(2_000);
    // The classic period does not apply to a ring already going.
    expect(oscillators()).toHaveLength(modern);
    vi.advanceTimersByTime(800);
    expect(oscillators()).toHaveLength(modern + 2);
    expect(
      oscillators()
        .slice(modern)
        .map((o) => o.hz),
    ).toEqual([[660], [880]]);
    expect(vi.getTimerCount()).toBe(1);

    stopRingChime();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(oscillators()).toHaveLength(modern + 2);
  });

  it("plays the next ringback burst in the new style and leaves no interval once stopped", () => {
    vi.useFakeTimers();
    savePref("soundStyle", "classic");
    startRingback();
    expect(oscillators().map((o) => o.hz)).toEqual([[440]]);

    savePref("soundStyle", "modern");
    vi.advanceTimersByTime(3_000);
    expect(oscillators()).toHaveLength(1 + soundSpec("modern", "ringback").length);

    stopRingback();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a new ring at the period of the style saved when it starts", () => {
    vi.useFakeTimers();
    savePref("soundStyle", "classic");
    startRingChime();
    stopRingChime();
    savePref("soundStyle", "modern");
    startRingChime();
    const first = oscillators().length;
    vi.advanceTimersByTime(2_000);
    expect(oscillators()).toHaveLength(first);
    vi.advanceTimersByTime(800);
    expect(oscillators().length).toBeGreaterThan(first);
  });
});
