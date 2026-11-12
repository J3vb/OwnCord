/**
 * DP-24: an incoming call gets noticed, and a missed call is reported. The
 * OS-level half (the call notification, the urgent attention request and the
 * missed-call notice) and the ringtone, driven the way the main page drives
 * them. The banner itself is the main page's (the mainPage/ tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../helpers/deferred";
import { makeDm } from "../helpers/dmHarness";
import type { RingState } from "../../src/lib/voice/callRing";

const { testPrefs, showCall, clearCall, requestAttention, showToast, notifier } = vi.hoisted(() => {
  const showCall = vi.fn();
  const clearCall = vi.fn();
  const requestAttention = vi.fn();
  /** A desktop's notifier; the Android app's also says `ringsCalls`. */
  const notifier: Record<string, unknown> & { ringsCalls?: boolean } = {
    showCall,
    clearCall,
    requestAttention,
  };
  return {
    testPrefs: new Map<string, unknown>(),
    showCall,
    clearCall,
    requestAttention,
    showToast: vi.fn(),
    notifier,
  };
});

vi.mock("../../src/lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs/preferences")>()),
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));
vi.mock("../../src/platform/desktop", () => ({ desktop: { notifier } }));
vi.mock("../../src/lib/ui/toast", () => ({ showToast }));

const {
  alertIncomingCall,
  alertMissedCall,
  alertRedial,
  alertSupersededCall,
  clearIncomingCall,
  isHostRing,
} = await import("../../src/features/direct-messages/callAlerts");
const { startRingChime, stopRingChime, playNotificationSound, startRingback, stopRingback } =
  await import("../../src/lib/media/notificationSound");
const { setChannelMutesHost } = await import("../../src/lib/prefs/channelMutes");
const { dmStore } = await import("../../src/stores/dm.store");

/** Every frequency the app's audio graph was asked to play, in order. */
const frequencies: number[] = [];
/** Every oscillator created, so a test can check that a burst in flight was
 *  cut (a `stop()` with no time), not merely left to finish its envelope. */
const oscillators: Array<{
  readonly hz: number;
  readonly stop: ReturnType<typeof vi.fn>;
}> = [];
class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  createOscillator() {
    let hz = 0;
    const osc = {
      connect: vi.fn(),
      frequency: {
        setValueAtTime: (value: number) => {
          hz = value;
          frequencies.push(value);
        },
      },
      start: vi.fn(),
      stop: vi.fn(),
      get hz() {
        return hz;
      },
    };
    oscillators.push(osc);
    return osc;
  }
  createGain() {
    return {
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    };
  }
  close() {
    return Promise.resolve();
  }
}
(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

const ring: RingState = { channelId: 50, fromUserId: 10, fromUsername: "Otto" };

/** A setting was saved while the app runs: its value, and the word of it. */
function saved(key: string, value: unknown): void {
  testPrefs.set(key, value);
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key } }));
}

beforeEach(() => {
  testPrefs.clear();
  frequencies.length = 0;
  oscillators.length = 0;
  showCall.mockReset().mockResolvedValue(undefined);
  clearCall.mockReset().mockResolvedValue(undefined);
  requestAttention.mockReset().mockResolvedValue(undefined);
  showToast.mockReset();
  setChannelMutesHost("a.example");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  stopRingChime();
  stopRingback();
  setChannelMutesHost(null);
  vi.restoreAllMocks();
});

describe("an incoming call", () => {
  it("when not focused, the ring calls the notifier's call notification and the attention request", () => {
    alertIncomingCall(ring);

    expect(showCall.mock.calls).toEqual([
      ["Otto is calling you", "Voice call", { host: "a.example", channelId: 50 }, true],
    ]);
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });

  // D-13: the ring's toast must not outlive the ring in the notification centre.
  it("withdraws the ring's notification when the ring ends", () => {
    clearIncomingCall(ring);
    expect(clearCall.mock.calls).toEqual([[50]]);
  });

  // The banner is the answer surface while the app is in front of the user;
  // an OS popup on top of it is the same alert twice.
  it("raises neither while the window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    alertIncomingCall(ring);
    expect(showCall).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  // OC-0037 / OC-0204: DND promises no popups and no sounds, but the flash is a
  // passive hint, and with the app in the tray it is the only signal left.
  it("DND suppresses the popup and the tone, but not the attention request", () => {
    testPrefs.set("userStatus", "dnd");

    alertIncomingCall(ring);
    startRingChime();

    expect(showCall).not.toHaveBeenCalled();
    expect(frequencies).toEqual([]);
    expect(requestAttention).toHaveBeenCalledTimes(1);
  });

  it("follows the desktop-notification and taskbar-flash toggles", () => {
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("flashTaskbar", false);
    alertIncomingCall(ring);
    expect(showCall).not.toHaveBeenCalled();
    expect(requestAttention).not.toHaveBeenCalled();
  });

  it("a notifier that is unavailable does not throw", async () => {
    showCall.mockRejectedValue(new Error("not a Tauri host"));
    requestAttention.mockRejectedValue(new Error("not a Tauri host"));
    expect(() => alertIncomingCall(ring)).not.toThrow();
    await Promise.resolve();
  });
});

describe("a missed call", () => {
  it("shows one in-app notice and one OS notification that opens the DM", () => {
    alertMissedCall(ring);

    expect(showToast.mock.calls).toEqual([["Missed call from Otto", "info"]]);
    expect(showCall.mock.calls).toEqual([
      ["Missed call from Otto", "Voice call", { host: "a.example", channelId: 50 }, false],
    ]);
    expect(requestAttention).not.toHaveBeenCalled();
  });

  // OC-0204: suppressing the popup must not hide the only record of the call.
  it("under DND, keeps the in-app notice and drops the popup", () => {
    testPrefs.set("userStatus", "dnd");
    alertMissedCall(ring);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showCall).not.toHaveBeenCalled();
  });
});

describe("a ring replaced by a ring from another channel (3B-4)", () => {
  afterEach(() => {
    dmStore.setState(() => ({ channels: [] }));
  });

  it("toasts a missed 1:1 call and sends no OS notification", () => {
    alertSupersededCall(ring);

    expect(showToast.mock.calls).toEqual([["Missed call from Otto", "info"]]);
    expect(showCall).not.toHaveBeenCalled();
  });

  it("names the group for a missed group call", () => {
    dmStore.setState(() => ({
      channels: [
        makeDm({
          channelId: 50,
          recipient: { id: 10, username: "Otto", avatar: "", status: "online" },
          participants: [{ id: 10, username: "Otto", avatar: "", status: "online" }],
          name: "Game night",
          isGroup: true,
        }),
      ],
    }));
    alertSupersededCall(ring);

    expect(showToast.mock.calls).toEqual([["Missed call in Game night", "info"]]);
  });
});

describe("the ringtone", () => {
  it("the tone is not the message chime", () => {
    playNotificationSound();
    const chime = [...frequencies];
    frequencies.length = 0;

    startRingChime();

    expect(frequencies.length).toBeGreaterThan(0);
    expect(frequencies).not.toEqual(chime);
    for (const hz of chime) expect(frequencies).not.toContain(hz);
  });

  it("repeats until stopped", () => {
    vi.useFakeTimers();
    try {
      startRingChime();
      const first = frequencies.length;
      vi.advanceTimersByTime(2_000);
      expect(frequencies.length).toBe(first * 2);
      stopRingChime();
      vi.advanceTimersByTime(10_000);
      expect(frequencies.length).toBe(first * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  // D2(b): the call sound has its own toggle. Turning message sounds off does
  // not silence a ringing phone; turning the call sound off does.
  it("plays with message sounds off, and is silenced by its own toggle", () => {
    testPrefs.set("notificationSounds", false);
    startRingChime();
    expect(frequencies.length).toBeGreaterThan(0);
    stopRingChime();

    frequencies.length = 0;
    testPrefs.set("callSounds", false);
    startRingChime();
    expect(frequencies).toEqual([]);
  });
});

// DP-25: the caller's ringback.
describe("the ringback", () => {
  it("is its own pattern, distinct from the incoming ringtone and the message chime", () => {
    startRingback();
    const ringback = [...frequencies];
    frequencies.length = 0;

    startRingChime();

    expect(ringback.length).toBeGreaterThan(0);
    expect(frequencies.length).toBeGreaterThan(0);
    for (const hz of ringback) expect(frequencies).not.toContain(hz);
  });

  it("is silenced by DND and by the call-sound toggle", () => {
    testPrefs.set("userStatus", "dnd");
    startRingback();
    expect(frequencies).toEqual([]);

    testPrefs.set("userStatus", "online");
    testPrefs.set("callSounds", false);
    startRingback();
    expect(frequencies).toEqual([]);
  });

  it("repeats until stopped", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      const first = frequencies.length;
      vi.advanceTimersByTime(3_000);
      expect(frequencies.length).toBe(first * 2);
      stopRingback();
      vi.advanceTimersByTime(10_000);
      expect(frequencies.length).toBe(first * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A client either calls or is called; an incoming ring replaces the
  // outgoing ringback rather than playing both (DP-25 acceptance).
  it("never plays at the same time as the incoming chime", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      startRingChime();
      vi.advanceTimersByTime(10_000);
      const ringtoneFreqs = frequencies.filter((hz) => hz === 660 || hz === 880);
      const ringbackFreqs = frequencies.filter((hz) => hz === 440);
      expect(ringbackFreqs.length).toBeGreaterThan(0);
      expect(ringtoneFreqs.length).toBeGreaterThan(0);
      // The ringback stopped when the chime started: its 3s interval is gone.
      const atRingtoneStart = frequencies.indexOf(660);
      expect(frequencies.slice(atRingtoneStart)).not.toContain(440);
    } finally {
      stopRingback();
      stopRingChime();
      vi.useRealTimers();
    }
  });

  // P3-02 acceptance: the two tones never overlap on one client. Clearing the
  // repeating interval is not enough: the burst already in flight keeps
  // sounding for its full envelope unless it is stopped.
  it("cuts the ringback burst in flight when an incoming chime pre-empts it", () => {
    startRingback();
    const burst = oscillators.find((o) => o.hz === 440);
    expect(burst).toBeDefined();
    burst!.stop.mockClear();

    startRingChime();

    expect(burst!.stop.mock.calls.some((call) => call.length === 0)).toBe(true);
  });

  it("cuts the chime burst in flight when the incoming ring ends", () => {
    startRingChime();
    const burst = oscillators.filter((o) => o.hz === 660 || o.hz === 880);
    expect(burst.length).toBeGreaterThan(0);
    for (const o of burst) o.stop.mockClear();

    stopRingChime();

    for (const o of burst) {
      expect(o.stop.mock.calls.some((call) => call.length === 0)).toBe(true);
    }
  });

  // An incoming ring pre-empts the outgoing ringback, but the outgoing call is
  // still ringing: when the incoming call ends the ringback must resume, not
  // stay silent for the rest of the outgoing ring.
  it("resumes when the incoming chime that pre-empted it ends", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      frequencies.length = 0;

      startRingChime();
      frequencies.length = 0;
      vi.advanceTimersByTime(4_000);
      expect(frequencies).not.toContain(440);

      stopRingChime();
      expect(frequencies).toContain(440);
    } finally {
      stopRingback();
      stopRingChime();
      vi.useRealTimers();
    }
  });

  // P3-02: DND is re-checked while the ring is in flight, so a caller who
  // switches it on mid-ring is silenced and hears the ring again when they
  // switch it off.
  it("follows a DND toggle made while the outgoing ring is in flight", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      frequencies.length = 0;

      saved("userStatus", "dnd");
      vi.advanceTimersByTime(6_000);
      expect(frequencies).not.toContain(440);

      saved("userStatus", "online");
      expect(frequencies).toContain(440);
    } finally {
      stopRingback();
      vi.useRealTimers();
    }
  });

  // The same axis as the call-sound toggle (D2(b)): muting or unmuting call
  // sounds mid-ring takes effect instead of being read only at start.
  it("follows a call-sound toggle made while the outgoing ring is in flight", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      frequencies.length = 0;

      saved("callSounds", false);
      vi.advanceTimersByTime(6_000);
      expect(frequencies).not.toContain(440);

      saved("callSounds", true);
      expect(frequencies).toContain(440);
    } finally {
      stopRingback();
      vi.useRealTimers();
    }
  });

  // A caller who hangs up (or is answered) during the incoming ring must not
  // have a ringback come back when that incoming call ends.
  it("does not resume after stopRingback", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      startRingChime();
      stopRingback();
      frequencies.length = 0;

      stopRingChime();
      vi.advanceTimersByTime(4_000);
      expect(frequencies).not.toContain(440);
    } finally {
      stopRingback();
      stopRingChime();
      vi.useRealTimers();
    }
  });
});

// The Android app's notification of a ringing call rings by itself, with the
// phone's ringtone. Every ring has one voice: the host's while the app is out
// of sight, the chime's while it is in front or the host will not show it.
describe("on a host whose call notification rings by itself", () => {
  const other: RingState = { channelId: 51, fromUserId: 11, fromUsername: "Mira" };
  const HOST_RING = ["Otto is calling you", "Voice call", { host: "a.example", channelId: 50 }];

  /** The page's order: the chime is asked for at once, the alert follows. */
  function ringStarts(which = ring): void {
    startRingChime();
    alertIncomingCall(which);
  }
  function ringEnds(which = ring): void {
    stopRingChime();
    clearIncomingCall(which);
  }
  /** The app is the one on screen, with the user's eye. */
  function appInFront(): void {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  }
  /** Let every answer the host has given so far land. */
  const hostAnswered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    notifier.ringsCalls = true;
  });
  afterEach(() => {
    ringEnds(ring);
    ringEnds(other);
    delete notifier.ringsCalls;
  });

  it("lets the host ring while the app is out of sight, and keeps the chime quiet", async () => {
    ringStarts();
    expect(showCall.mock.calls).toEqual([[...HOST_RING, true, false]]);
    await hostAnswered();
    expect(frequencies).toEqual([]);
  });

  it.each(["callSounds", "soundRing"])(
    "asks for a ring without a sound while %s is off, and stays quiet itself",
    async (pref) => {
      testPrefs.set(pref, false);
      ringStarts();
      expect(showCall.mock.calls).toEqual([[...HOST_RING, true, true]]);
      await hostAnswered();
      expect(frequencies).toEqual([]);
    },
  );

  it("rings by itself with the app in front, once it is known the host does not", () => {
    appInFront();
    startRingChime();
    // Nobody has said yet whether the host rings: no blip before it would.
    expect(frequencies).toEqual([]);
    alertIncomingCall(ring);
    expect(showCall).not.toHaveBeenCalled();
    expect(frequencies.length).toBeGreaterThan(0);
  });

  it("counts an app that has focus but is not on screen as out of sight", () => {
    appInFront();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    ringStarts();
    expect(showCall).toHaveBeenCalledOnce();
    expect(frequencies).toEqual([]);
  });

  it("under do not disturb rings nowhere", async () => {
    testPrefs.set("userStatus", "dnd");
    ringStarts();
    await hostAnswered();
    expect(showCall).not.toHaveBeenCalled();
    expect(frequencies).toEqual([]);
  });

  it("with notifications off in the app, rings by itself", () => {
    testPrefs.set("desktopNotifications", false);
    ringStarts();
    expect(showCall).not.toHaveBeenCalled();
    expect(frequencies.length).toBeGreaterThan(0);
  });

  it("rings by itself after all when the host will not show the ring", async () => {
    showCall.mockRejectedValue(new Error("call ring: notifications are off"));
    ringStarts();
    expect(frequencies).toEqual([]);
    await hostAnswered();
    expect(frequencies.length).toBeGreaterThan(0);
  });

  it("ignores a refusal that comes back after its ring ended", async () => {
    const late = createDeferred();
    showCall.mockReturnValueOnce(late.promise);
    ringStarts();
    ringEnds();
    ringStarts(other);
    late.reject(new Error("call ring: notifications are off"));
    await hostAnswered();
    // The newer ring is the host's, and stays so.
    expect(showCall).toHaveBeenCalledTimes(2);
    expect(frequencies).toEqual([]);
  });

  it("shows a ring that is rung again on the host again, so its time starts over", () => {
    ringStarts();
    alertRedial(ring);
    // That ring only: another call rung again is not the one the host has.
    alertRedial(other);
    expect(showCall.mock.calls).toEqual([
      [...HOST_RING, true, false],
      [...HOST_RING, true, false],
    ]);
  });

  it("leaves a ring it rings by itself alone when that is rung again", async () => {
    appInFront();
    ringStarts();
    alertRedial(ring);
    expect(showCall).not.toHaveBeenCalled();

    // The same for a ring the host refused: the chime has it.
    ringEnds();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    showCall.mockRejectedValue(new Error("call ring: notifications are off"));
    ringStarts();
    await hostAnswered();
    alertRedial(ring);
    expect(showCall).toHaveBeenCalledOnce();
  });

  it("takes the ring down when it ends, and waits for the word again at the next", () => {
    appInFront();
    ringStarts();
    ringEnds();
    expect(clearCall.mock.calls).toEqual([[50]]);
    frequencies.length = 0;

    startRingChime();
    expect(frequencies).toEqual([]);
  });

  it("does not keep a refusal that came after its ring's sound stopped for the next ring", async () => {
    const late = createDeferred();
    showCall.mockReturnValueOnce(late.promise);
    ringStarts();
    // The page's order at a ring's end: the sound stops at once, the
    // notification is withdrawn a moment later. The refusal lands in between.
    stopRingChime();
    late.reject(new Error("call ring: notifications are off"));
    await hostAnswered();
    clearIncomingCall(ring);

    startRingChime();
    expect(frequencies).toEqual([]);
  });

  it("makes a ring that takes another's place wait for its own word", () => {
    appInFront();
    ringStarts();
    expect(frequencies.length).toBeGreaterThan(0);
    // The newer ring asks for its sound before the older one is withdrawn.
    stopRingChime();
    frequencies.length = 0;
    startRingChime();
    expect(frequencies).toEqual([]);
    clearIncomingCall(ring);
    expect(frequencies).toEqual([]);
  });

  it("holds the outgoing ringback back while the host rings, and gives it back after", () => {
    vi.useFakeTimers();
    try {
      startRingback();
      ringStarts();
      frequencies.length = 0;
      vi.advanceTimersByTime(6_000);
      expect(frequencies).toEqual([]);

      ringEnds();
      expect(frequencies).toContain(440);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the outgoing ringback go on under a ring the host shows without a sound", () => {
    vi.useFakeTimers();
    try {
      testPrefs.set("soundRing", false);
      startRingback();
      ringStarts();
      frequencies.length = 0;
      vi.advanceTimersByTime(3_000);
      expect(frequencies).toContain(440);
    } finally {
      vi.useRealTimers();
    }
  });

  // What the member switches off while the phone rings holds for that ring at
  // once, as it would for the app's own chime.
  describe("when a setting is saved while the host rings", () => {
    const LOUD = [...HOST_RING, true, false];
    const QUIET = [...HOST_RING, true, true];
    const refusal = (): Error => new Error("call ring: notifications are off");

    it.each(["callSounds", "soundRing"])(
      "shows the ring again without a sound once %s is off, and stays quiet itself",
      async (pref) => {
        ringStarts();
        saved(pref, false);
        expect(showCall.mock.calls).toEqual([LOUD, QUIET]);
        expect(clearCall).not.toHaveBeenCalled();
        await hostAnswered();
        expect(frequencies).toEqual([]);
      },
    );

    it("shows a ring without a sound once, and does not start it when the sound comes back", () => {
      ringStarts();
      saved("soundRing", false);
      saved("callSounds", false);
      saved("callSounds", true);
      saved("soundRing", true);
      expect(showCall.mock.calls).toEqual([LOUD, QUIET]);
    });

    it("leaves the ring as it is for a setting that says nothing about it", () => {
      ringStarts();
      saved("theme", "dark");
      expect(showCall).toHaveBeenCalledOnce();
      expect(clearCall).not.toHaveBeenCalled();
    });

    it("takes the ring down and rings by itself once notifications are off in the app", () => {
      ringStarts();
      saved("desktopNotifications", false);
      expect(clearCall.mock.calls).toEqual([[50]]);
      expect(showCall).toHaveBeenCalledOnce();
      expect(frequencies.length).toBeGreaterThan(0);
    });

    it("takes the ring down and rings nowhere once do not disturb is on", async () => {
      ringStarts();
      saved("userStatus", "dnd");
      await hostAnswered();
      expect(clearCall.mock.calls).toEqual([[50]]);
      expect(showCall).toHaveBeenCalledOnce();
      expect(frequencies).toEqual([]);
    });

    it("keeps a ring it took back: rung again, or with notifications back on, it stays the app's", () => {
      ringStarts();
      saved("desktopNotifications", false);
      saved("desktopNotifications", true);
      alertRedial(ring);
      expect(showCall).toHaveBeenCalledOnce();
      expect(clearCall).toHaveBeenCalledOnce();
    });

    it("asks again whether it may show a ring that is rung again", () => {
      ringStarts();
      // Switched off without a word of it reaching this page.
      testPrefs.set("desktopNotifications", false);
      alertRedial(ring);
      expect(showCall).toHaveBeenCalledOnce();
      expect(clearCall.mock.calls).toEqual([[50]]);
      expect(frequencies.length).toBeGreaterThan(0);
    });

    it("follows a setting once for a ring that was rung again", () => {
      ringStarts();
      alertRedial(ring);
      saved("soundRing", false);
      expect(showCall.mock.calls).toEqual([LOUD, LOUD, QUIET]);
    });

    it("follows no setting once the ring ended", () => {
      ringStarts();
      ringEnds();
      clearCall.mockClear();
      saved("soundRing", false);
      saved("desktopNotifications", false);
      expect(showCall).toHaveBeenCalledOnce();
      expect(clearCall).not.toHaveBeenCalled();
    });

    it("follows no setting for a ring the host refused", async () => {
      showCall.mockRejectedValueOnce(refusal());
      ringStarts();
      await hostAnswered();
      saved("desktopNotifications", false);
      expect(showCall).toHaveBeenCalledOnce();
      expect(clearCall).not.toHaveBeenCalled();
    });

    it("keeps the ring it showed again when the host refuses the first showing late", async () => {
      const late = createDeferred();
      showCall.mockReturnValueOnce(late.promise);
      ringStarts();
      saved("soundRing", false);
      late.reject(refusal());
      await hostAnswered();
      // Still the host's: rung again, it is shown there again.
      alertRedial(ring);
      expect(showCall.mock.calls).toEqual([LOUD, QUIET, QUIET]);
    });
  });

  describe("whose notification a press is about", () => {
    const pressed: RingState = { channelId: 77, fromUserId: 12, fromUsername: "Ines" };
    afterEach(() => ringEnds(pressed));

    it("is this page's for the ring it put there, after that ring ended too", () => {
      expect(isHostRing(77)).toBe(false);
      ringStarts(pressed);
      expect(isHostRing(77)).toBe(true);
      expect(isHostRing(50)).toBe(false);
      ringEnds(pressed);
      // A press on it can still be on its way.
      expect(isHostRing(77)).toBe(true);
    });

    it("is not this page's once another server is signed in", () => {
      ringStarts(pressed);
      setChannelMutesHost("b.example");
      expect(isHostRing(77)).toBe(false);
    });

    it("is not this page's for a ring it rang by itself", () => {
      appInFront();
      ringStarts(other);
      expect(isHostRing(51)).toBe(false);
    });
  });
});
