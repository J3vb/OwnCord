/**
 * Settings previews of the app sounds: they play through the same player as
 * the real sounds but skip every gate, one after another with a pause taken
 * from each spec's length, one preview at a time, owned by a signal.
 * Preferences are the real ones; Web Audio, the native host and the platform
 * check are stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/platform/desktop", async () =>
  (await import("../helpers/appSoundHost")).soundHostDesktop(),
);
vi.mock("../../src/features/voice/native/platform", async () =>
  (await import("../helpers/appSoundHost")).soundHostPlatform(),
);

import {
  cleanupNotificationAudio,
  playCallEnded,
  playNotificationSound,
  startRingChime,
  stopRingChime,
} from "@lib/media/notificationSound";
import { PREVIEW_GAP_MS, previewSounds, specLengthMs } from "@lib/media/soundPreview";
import { soundSpec, type AppSound, type ToneSpec } from "@lib/media/soundTables";
import { savePref } from "@lib/prefs/preferences";
import { setVoiceDeafened, setVoiceInSession } from "@lib/voice/voiceDeafened";
import { RecordingAudioContext, recordedOscillators } from "../helpers/audioContextMock";
import { soundHost as host } from "../helpers/appSoundHost";

const spec = (sound: AppSound): ToneSpec => soundSpec("modern", sound);
/** The first frequency of each note of `sound`, as the oscillators record it. */
const firstHz = (sound: AppSound): number[] => spec(sound).map((n) => n.freqs[0]![1]);
const played = (): number[] => recordedOscillators().map((o) => o.hz[0]!);
/** Oscillators stopped early, i.e. cut (a scheduled stop passes its end time). */
const cutOne = (o: ReturnType<typeof recordedOscillators>[number]): boolean =>
  o.stop.mock.calls.some((c) => c.length === 0);
const cut = (): number => recordedOscillators().filter(cutOne).length;

let ac: AbortController;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", RecordingAudioContext);
  host.linux = false;
  host.playSound.mockReset();
  host.stopSound.mockReset().mockResolvedValue(undefined);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  stopRingChime();
  cleanupNotificationAudio();
  setVoiceDeafened(false);
  setVoiceInSession(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("specLengthMs", () => {
  it("is the latest note end, release included", () => {
    const notes: ToneSpec = [
      { at: 0, duration: 0.1, gain: 0.2, endGain: 0.001, freqs: [[0, 440]], release: 0.05 },
      { at: 0.2, duration: 0.15, gain: 0.2, endGain: 0.001, freqs: [[0, 660]] },
      { at: 0.1, duration: 0.2, gain: 0.2, endGain: 0.001, freqs: [[0, 880]], release: 0.02 },
    ];
    expect(specLengthMs(notes)).toBeCloseTo(350);
    expect(specLengthMs([])).toBe(0);
  });
});

describe("gates", () => {
  it("previews while deafened in a call, though the message sound itself is silent", () => {
    setVoiceInSession(true);
    setVoiceDeafened(true);
    playNotificationSound();
    expect(recordedOscillators()).toHaveLength(0);

    previewSounds(["message"], ac.signal);
    expect(played()).toEqual(firstHz("message"));
  });

  it("previews on Do Not Disturb with every switch off, though the real ones stay silent", () => {
    savePref("userStatus", "dnd");
    for (const key of ["notificationSounds", "callSounds", "voiceSounds"]) savePref(key, false);
    for (const key of ["soundRing", "soundRingback", "soundMessage", "soundJoinLeave"]) {
      savePref(key, false);
    }
    startRingChime();
    playCallEnded();
    expect(recordedOscillators()).toHaveLength(0);

    previewSounds(["ring"], ac.signal);
    expect(played()).toEqual(firstHz("ring"));
  });

  it("never starts the ring or ringback interval", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    previewSounds(["ring"], ac.signal);
    vi.advanceTimersByTime(10_000);
    expect(interval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays each sound in the style saved when it starts", () => {
    savePref("soundStyle", "classic");
    previewSounds(["mute"], ac.signal);
    expect(played()).toEqual(soundSpec("classic", "mute").map((n) => n.freqs[0]![1]));
  });
});

describe("sequence", () => {
  it("starts each sound the gap after the previous one ended, then ends", () => {
    const onEnd = vi.fn();
    const sounds: AppSound[] = ["mute", "unmute", "deafen", "undeafen"];
    previewSounds(sounds, ac.signal, onEnd);
    expect(played()).toEqual(firstHz("mute"));

    let heard = firstHz("mute");
    for (let i = 1; i < sounds.length; i++) {
      const wait = specLengthMs(spec(sounds[i - 1]!)) + PREVIEW_GAP_MS;
      vi.advanceTimersByTime(wait - 1);
      expect(played()).toEqual(heard);
      vi.advanceTimersByTime(1);
      heard = [...heard, ...firstHz(sounds[i]!)];
      expect(played()).toEqual(heard);
    }
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(specLengthMs(spec("undeafen")) - 1);
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    // A sound that ended on its own is not cut.
    expect(cut()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop cuts the sound in flight, plays nothing more and ends once", () => {
    const onEnd = vi.fn();
    const preview = previewSounds(["join", "leave"], ac.signal, onEnd);
    preview?.stop();
    preview?.stop();
    expect(cut()).toBe(spec("join").length);
    expect(onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(played()).toEqual(firstHz("join"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a newer preview cuts the one before, waiting between its sounds", () => {
    const firstEnd = vi.fn();
    previewSounds(["mute", "unmute", "deafen", "undeafen"], ac.signal, firstEnd);
    vi.advanceTimersByTime(specLengthMs(spec("mute")) + PREVIEW_GAP_MS);
    vi.advanceTimersByTime(specLengthMs(spec("unmute")) + 100);
    const before = played();

    previewSounds(["pttOn", "pttOff"], ac.signal);
    expect(firstEnd).toHaveBeenCalledTimes(1);
    // Pressed in the pause after unmute: the deafen never comes.
    vi.advanceTimersByTime(10_000);
    expect(played()).toEqual([...before, ...firstHz("pttOn"), ...firstHz("pttOff")]);
    expect(played()).not.toContain(firstHz("deafen")[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a newer preview cuts the sound the one before has in flight", () => {
    previewSounds(["join", "leave", "moved"], ac.signal);
    expect(cut()).toBe(0);
    previewSounds(["message"], ac.signal);
    expect(cut()).toBe(spec("join").length);
    vi.advanceTimersByTime(10_000);
    expect(played()).toEqual([...firstHz("join"), ...firstHz("message")]);
  });

  it("aborting the owner on the second of four sounds cuts it and leaves no timer", () => {
    const onEnd = vi.fn();
    previewSounds(["streamStart", "streamEnd", "viewerJoin", "viewerLeave"], ac.signal, onEnd);
    vi.advanceTimersByTime(specLengthMs(spec("streamStart")) + PREVIEW_GAP_MS + 10);
    expect(played()).toEqual([...firstHz("streamStart"), ...firstHz("streamEnd")]);

    ac.abort();

    const streamEnd = recordedOscillators().slice(spec("streamStart").length);
    expect(streamEnd.every((o) => o.stop.mock.calls.some((c) => c.length === 0))).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(played()).toHaveLength(spec("streamStart").length + spec("streamEnd").length);
  });

  it("starts nothing on an owner that already ended", () => {
    ac.abort();
    const onEnd = vi.fn();
    expect(previewSounds(["message"], ac.signal, onEnd)).toBeNull();
    expect(recordedOscillators()).toHaveLength(0);
    expect(onEnd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts nothing for an empty list", () => {
    const onEnd = vi.fn();
    expect(previewSounds([], ac.signal, onEnd)).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(recordedOscillators()).toHaveLength(0);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("stopping a preview leaves a ringing call's tone alone", () => {
    startRingChime();
    const ring = recordedOscillators().length;
    expect(ring).toBe(spec("ring").length);
    previewSounds(["mute"], ac.signal)?.stop();
    expect(cut()).toBe(spec("mute").length);
    expect(
      recordedOscillators()
        .slice(0, ring)
        .every((o) => cutOne(o) === false),
    ).toBe(true);
  });
});

describe("on the Linux native host", () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  it("plays through the host at the saved volume and device, ungated", async () => {
    host.linux = true;
    host.playSound.mockResolvedValue(3);
    savePref("audioOutputDevice", "guid-headset");
    savePref("appSoundsVolume", 40);
    savePref("userStatus", "dnd");
    previewSounds(["mention"], ac.signal);
    await settle();
    expect(host.playSound).toHaveBeenCalledWith(spec("mention"), "guid-headset", 0.4);
    expect(recordedOscillators()).toHaveLength(0);
  });

  it("falls back to Web Audio when the host refuses, and still ends on time", async () => {
    host.linux = true;
    host.playSound.mockRejectedValue(new Error("no output device"));
    const onEnd = vi.fn();
    previewSounds(["mention"], ac.signal, onEnd);
    await settle();
    expect(played()).toEqual(firstHz("mention"));
    vi.advanceTimersByTime(specLengthMs(spec("mention")));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("a newer press before the host answered stops the late id; only the new sounds follow", async () => {
    host.linux = true;
    let answer: (id: number) => void = () => undefined;
    host.playSound
      .mockImplementationOnce(() => new Promise<number>((resolve) => (answer = resolve)))
      .mockResolvedValue(9);
    previewSounds(["connectionLost", "join"], ac.signal);
    previewSounds(["pttOn", "pttOff"], ac.signal);

    answer(5);
    await settle();
    expect(host.stopSound).toHaveBeenCalledWith(5);
    expect(host.stopSound).not.toHaveBeenCalledWith(9);

    vi.advanceTimersByTime(10_000);
    await settle();
    const sent = host.playSound.mock.calls.map((c) => c[0]);
    expect(sent).toEqual([spec("connectionLost"), spec("pttOn"), spec("pttOff")]);
  });

  it("closing settings before the host answered stops the late id", async () => {
    host.linux = true;
    let answer: (id: number) => void = () => undefined;
    host.playSound.mockImplementationOnce(
      () => new Promise<number>((resolve) => (answer = resolve)),
    );
    previewSounds(["ringback", "callEnded"], ac.signal);
    ac.abort();
    answer(4);
    await settle();
    expect(host.stopSound).toHaveBeenCalledWith(4);
    expect(host.playSound).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
