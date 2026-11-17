/**
 * The caller's call-ended tone: the outgoing ring ending without a call
 * (declined, no answer, the 1:1 callee offline) plays it once, after the
 * ringback is cut, under the ringback's gates. An answered call and the
 * caller's own hang-up play nothing. Preferences are the real ones; the ring
 * runs on the real `createOutgoingCall` wired as the page wires it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/platform/desktop", () => ({
  desktop: { nativeVoice: {}, notifier: {} },
}));
vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => false,
  isWindowsDesktop: () => false,
}));

import {
  cleanupNotificationAudio,
  playCallEnded,
  startRingChime,
  startRingback,
  stopRingChime,
  stopRingback,
} from "@lib/media/notificationSound";
import { createOutgoingCall, type OutgoingCall } from "@lib/voice/callRing";
import { soundSpec } from "@lib/media/soundTables";
import { savePref } from "@lib/prefs/preferences";
import { setVoiceDeafened, setVoiceInSession } from "@lib/voice/voiceDeafened";
import { RecordingAudioContext, recordedOscillators } from "../helpers/audioContextMock";

const CALL_ENDED = soundSpec("modern", "callEnded").map((n) => n.freqs.map(([, hz]) => hz));
const RINGBACK = soundSpec("modern", "ringback").length;

/** The oscillators of every call-ended tone played so far. */
function callEndedTones(): number {
  const hz = recordedOscillators().map((o) => o.hz);
  let count = 0;
  for (let i = 0; i + CALL_ENDED.length <= hz.length; i++) {
    if (CALL_ENDED.every((want, k) => want[0] === hz[i + k]![0])) count++;
  }
  return count;
}

let call: OutgoingCall;
let ringTimeout: (() => void) | null;
const onUnanswered = vi.fn(() => playCallEnded());
const events: string[] = [];

beforeEach(() => {
  localStorage.clear();
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", RecordingAudioContext);
  ringTimeout = null;
  events.length = 0;
  onUnanswered.mockClear();
  call = createOutgoingCall({
    onChange: (state) => events.push(state?.phase ?? "none"),
    onRingback: (playing) => {
      events.push(playing ? "ringback on" : "ringback off");
      if (playing) startRingback();
      else stopRingback();
    },
    onUnanswered: () => {
      events.push("unanswered");
      onUnanswered();
    },
    setTimer: (fn) => {
      ringTimeout = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      ringTimeout = null;
    },
  });
});

afterEach(() => {
  call.destroy();
  stopRingChime();
  cleanupNotificationAudio();
  setVoiceDeafened(false);
  setVoiceInSession(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the outgoing ring's outcome", () => {
  it("plays the tone once when the 1:1 callee declines, after the ringback is cut", () => {
    call.start(5, [2]);
    const ringback = recordedOscillators().slice(0, RINGBACK);
    expect(ringback).toHaveLength(RINGBACK);

    call.declined(5, 2);

    expect(events).toEqual(["ringback on", "ringing", "ringback off", "declined", "unanswered"]);
    for (const o of ringback) expect(o.stop).toHaveBeenCalledWith();
    expect(callEndedTones()).toBe(1);
  });

  it("plays it once when nobody answers in time", () => {
    call.start(5, [2, 3]);
    ringTimeout!();
    expect(events.at(-1)).toBe("unanswered");
    expect(callEndedTones()).toBe(1);
  });

  it("plays it once for an offline callee, with no ringback before it", () => {
    call.start(5, [2], true);
    expect(events).toEqual(["offline", "unanswered"]);
    expect(recordedOscillators()).toHaveLength(CALL_ENDED.length);
    expect(callEndedTones()).toBe(1);
  });

  it("does not play while a group still rings for someone", () => {
    call.start(5, [2, 3]);
    call.declined(5, 2);
    expect(onUnanswered).not.toHaveBeenCalled();
    call.declined(5, 3);
    expect(onUnanswered).toHaveBeenCalledTimes(1);
  });

  it("does not play when the call is answered or the caller hangs up", () => {
    call.start(5, [2]);
    call.clear();
    call.start(6, [3]);
    call.clear();
    expect(ringTimeout).toBeNull();
    call.declined(6, 3);
    expect(onUnanswered).not.toHaveBeenCalled();
    expect(callEndedTones()).toBe(0);
  });

  describe("two outcomes racing", () => {
    it("a decline landing as the ring times out plays once", () => {
      call.start(5, [2]);
      const timeout = ringTimeout!;
      call.declined(5, 2);
      timeout();
      expect(onUnanswered).toHaveBeenCalledTimes(1);
      expect(callEndedTones()).toBe(1);
    });

    it("a ring timing out as the decline lands plays once", () => {
      call.start(5, [2]);
      ringTimeout!();
      call.declined(5, 2);
      expect(onUnanswered).toHaveBeenCalledTimes(1);
    });

    it("a decline landing after the caller hung up plays nothing", () => {
      call.start(5, [2]);
      const timeout = ringTimeout!;
      call.clear();
      call.declined(5, 2);
      timeout();
      expect(onUnanswered).not.toHaveBeenCalled();
      expect(callEndedTones()).toBe(0);
    });
  });
});

describe("the tone's gates, the ringback's", () => {
  const silencers: ReadonlyArray<readonly [string, () => void]> = [
    ["under Do Not Disturb", () => savePref("userStatus", "dnd")],
    ["with the call sound switch off", () => savePref("callSounds", false)],
    ["with the ringback switch off", () => savePref("soundRingback", false)],
    [
      "while deafened in a voice session",
      () => {
        setVoiceDeafened(true);
        setVoiceInSession(true);
      },
    ],
    ["while an incoming ring sounds", () => startRingChime()],
  ];

  it.each(silencers)("is silent %s", (_, silence) => {
    silence();
    playCallEnded();
    expect(callEndedTones()).toBe(0);
  });

  it("plays its modern sound in classic as well", () => {
    savePref("soundStyle", "classic");
    playCallEnded();
    expect(callEndedTones()).toBe(1);
  });

  it.each([
    ["a new ringback starts", () => startRingback()],
    ["an incoming ring starts", () => startRingChime()],
  ])("is cut when %s", (_, next) => {
    playCallEnded();
    const tone = recordedOscillators().slice();
    next();
    for (const o of tone) expect(o.stop).toHaveBeenCalledWith();
    stopRingback();
  });

  it("is cut when the session's audio is cleaned up", () => {
    playCallEnded();
    cleanupNotificationAudio();
    for (const o of recordedOscillators()) expect(o.stop).toHaveBeenCalledWith();
  });
});
