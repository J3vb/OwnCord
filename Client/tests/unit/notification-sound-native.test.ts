/**
 * WP LP-6b: on the Linux desktop an app sound is sent to the native host as a
 * tone spec and played on the saved output device; anywhere else, and on any
 * host failure, it is the Web Audio sound it always was. Gates (deafen, DND)
 * stay ahead of the routing. Preferences are the real ones; the native host
 * and the platform check are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const host = vi.hoisted(() => ({
  linux: true,
  playSound: vi.fn(),
  stopSound: vi.fn(),
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: { nativeVoice: { playSound: host.playSound, stopSound: host.stopSound } },
}));
vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => host.linux,
  isWindowsDesktop: () => false,
}));

import {
  cleanupNotificationAudio,
  playNotificationSound,
  playVoiceSound,
  startRingChime,
  startRingback,
  stopRingback,
  stopRingChime,
  type VoiceSound,
} from "@lib/notificationSound";
import { savePref } from "@lib/prefs/preferences";
import { setVoiceDeafened, setVoiceInSession } from "@lib/voiceDeafened";
import type { NativeToneNote } from "../../src/platform/contracts/nativeVoice";

/** One Web Audio note as the oscillator and gain nodes saw it. */
interface WebNote {
  freqs: Array<[number, number]>;
  gain: Array<[number, number]>;
  start: number;
  stop: number;
}

class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];
  readonly currentTime = 0;
  readonly destination = {};
  readonly notes: WebNote[] = [];
  readonly close = vi.fn(async () => {});

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  createOscillator() {
    const note: WebNote = { freqs: [], gain: [], start: NaN, stop: NaN };
    this.notes.push(note);
    return {
      connect: vi.fn(),
      start: (t: number) => (note.start = t),
      stop: (t?: number) => {
        if (t !== undefined) note.stop = t;
      },
      frequency: { setValueAtTime: (hz: number, t: number) => note.freqs.push([t, hz]) },
    };
  }

  createGain() {
    const note = (): WebNote | undefined => this.notes[this.notes.length - 1];
    return {
      connect: vi.fn(),
      gain: {
        value: 1,
        setValueAtTime: (v: number, t: number) => note()?.gain.push([t, v]),
        exponentialRampToValueAtTime: (v: number, t: number) => note()?.gain.push([t, v]),
      },
    };
  }
}

/** The Web Audio notes of the sounds played so far, minus the master gain. */
function webNotes(): WebNote[] {
  return RecordingAudioContext.instances.flatMap((c) => c.notes);
}

/** A native note in the shape the Web Audio nodes record. */
function asWeb(n: NativeToneNote): WebNote {
  return {
    freqs: n.freqs.map(([offset, hz]) => [n.at + offset, hz]),
    gain: [
      [n.at, n.gain],
      [n.at + n.duration, n.endGain],
    ],
    start: n.at,
    stop: n.at + n.duration,
  };
}

const VOICE_SOUNDS: VoiceSound[] = [
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

/** Let the mocked host's promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", RecordingAudioContext);
  host.linux = true;
  host.playSound.mockReset().mockResolvedValue(1);
  host.stopSound.mockReset().mockResolvedValue(undefined);
  setVoiceDeafened(false);
  setVoiceInSession(false);
});

afterEach(() => {
  stopRingChime();
  cleanupNotificationAudio();
  setVoiceDeafened(false);
  setVoiceInSession(false);
  vi.unstubAllGlobals();
});

describe("app sounds on the native host (Linux)", () => {
  it("on Linux a voice sound plays through the native command on the saved output at the app-sounds gain", async () => {
    savePref("audioOutputDevice", "guid-headset");
    savePref("appSoundsVolume", 40);
    playVoiceSound("mute");
    await settle();
    expect(host.playSound).toHaveBeenCalledTimes(1);
    const [notes, device, gain] = host.playSound.mock.calls[0] as [
      NativeToneNote[],
      string,
      number,
    ];
    expect(notes).toEqual([{ at: 0, duration: 0.12, gain: 0.2, endGain: 0.01, freqs: [[0, 392]] }]);
    expect(device).toBe("guid-headset");
    expect(gain).toBeCloseTo(0.4);
    // Played natively: Web Audio never started.
    expect(RecordingAudioContext.instances).toHaveLength(0);
    expect(host.stopSound).not.toHaveBeenCalled();
  });

  it("the spec sent natively matches the Web Audio notes for every sound", async () => {
    const played: Array<[string, () => void]> = [
      ["message chime", () => playNotificationSound()],
      ...VOICE_SOUNDS.map((k): [string, () => void] => [k, () => playVoiceSound(k)]),
    ];
    for (const [label, play] of played) {
      host.linux = false;
      cleanupNotificationAudio();
      RecordingAudioContext.instances = [];
      play();
      const web = webNotes();
      host.linux = true;
      host.playSound.mockClear();
      play();
      await settle();
      const sent = host.playSound.mock.calls[0]?.[0] as NativeToneNote[];
      expect(sent.map(asWeb), label).toEqual(web);
    }
    // The ring chime is two notes per burst and the ringback one: both come
    // from the same table, so a native ring plays the notes Web Audio would.
    host.linux = false;
    cleanupNotificationAudio();
    RecordingAudioContext.instances = [];
    startRingChime();
    const ringWeb = webNotes();
    stopRingChime();
    host.linux = true;
    host.playSound.mockClear();
    startRingChime();
    await settle();
    const ringSent = host.playSound.mock.calls[0]?.[0] as NativeToneNote[];
    expect(ringSent.map(asWeb)).toEqual(ringWeb);
    expect(ringSent).toHaveLength(2);
  });

  it("a native failure falls back to Web Audio", async () => {
    host.playSound.mockResolvedValue(null);
    playNotificationSound();
    await settle();
    expect(host.playSound).toHaveBeenCalledTimes(1);
    expect(webNotes()).toHaveLength(1);
    expect(webNotes()[0]?.freqs).toEqual([
      [0, 800],
      [0.1, 600],
    ]);
  });

  it("stopping the ring chime before the native id arrives stops that sound when it lands and never falls back", async () => {
    let answer: (id: number | null) => void = () => {};
    host.playSound.mockReturnValue(
      new Promise<number | null>((resolve) => {
        answer = resolve;
      }),
    );
    startRingChime();
    expect(host.playSound).toHaveBeenCalledTimes(1);
    stopRingChime();
    expect(host.stopSound).not.toHaveBeenCalled();
    answer(7);
    await settle();
    expect(host.stopSound).toHaveBeenCalledWith(7);
    expect(RecordingAudioContext.instances).toHaveLength(0);

    // A host failure for a burst that was already stopped plays nothing.
    host.playSound.mockReturnValue(
      new Promise<number | null>((resolve) => {
        answer = resolve;
      }),
    );
    startRingChime();
    stopRingChime();
    answer(null);
    await settle();
    expect(RecordingAudioContext.instances).toHaveLength(0);
    expect(host.stopSound).toHaveBeenCalledTimes(1);
  });

  it("stopping a burst whose id has arrived cuts it natively", async () => {
    host.playSound.mockResolvedValue(9);
    startRingChime();
    await settle();
    expect(host.stopSound).not.toHaveBeenCalled();
    stopRingChime();
    expect(host.stopSound).toHaveBeenCalledWith(9);
  });

  it("deafened or DND, nothing reaches the native command", async () => {
    setVoiceDeafened(true);
    setVoiceInSession(true);
    playNotificationSound();
    startRingback();
    await settle();
    expect(host.playSound).not.toHaveBeenCalled();
    stopRingback();
    setVoiceDeafened(false);
    savePref("userStatus", "dnd");
    startRingChime();
    startRingback();
    await settle();
    expect(host.playSound).not.toHaveBeenCalled();
  });

  it("off Linux the native command is never called", async () => {
    host.linux = false;
    playNotificationSound();
    playVoiceSound("join");
    startRingChime();
    await settle();
    expect(host.playSound).not.toHaveBeenCalled();
    expect(host.stopSound).not.toHaveBeenCalled();
    expect(webNotes().length).toBeGreaterThan(0);
  });
});
