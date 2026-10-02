/**
 * DP-24: an incoming call gets noticed, and a missed call is reported. The
 * OS-level half (the call notification, the urgent attention request and the
 * missed-call notice) and the ringtone, driven the way the main page drives
 * them. The banner itself is the main page's (main-page.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RingState } from "../../src/lib/call-ring";

const { testPrefs, showCall, requestAttention, showToast } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
  showCall: vi.fn(),
  requestAttention: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../../src/lib/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));
vi.mock("../../src/platform/desktop", () => ({
  desktop: { notifier: { showCall, requestAttention } },
}));
vi.mock("../../src/lib/toast", () => ({ showToast }));

const { alertIncomingCall, alertMissedCall } =
  await import("../../src/features/direct-messages/callAlerts");
const { startRingChime, stopRingChime, playNotificationSound, startRingback, stopRingback } =
  await import("../../src/lib/notificationSound");
const { setChannelMutesHost } = await import("../../src/lib/channel-mutes");

/** Every frequency the app's audio graph was asked to play, in order. */
const frequencies: number[] = [];
class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  createOscillator() {
    return {
      connect: vi.fn(),
      frequency: { setValueAtTime: (hz: number) => frequencies.push(hz) },
      start: vi.fn(),
      stop: vi.fn(),
    };
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

beforeEach(() => {
  testPrefs.clear();
  frequencies.length = 0;
  showCall.mockReset().mockResolvedValue(undefined);
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
      ["Otto is calling you", "Voice call", { host: "a.example", channelId: 50 }],
    ]);
    expect(requestAttention).toHaveBeenCalledTimes(1);
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
      ["Missed call from Otto", "Voice call", { host: "a.example", channelId: 50 }],
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

      testPrefs.set("userStatus", "dnd");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", { detail: { key: "userStatus" } }),
      );
      vi.advanceTimersByTime(6_000);
      expect(frequencies).not.toContain(440);

      testPrefs.set("userStatus", "online");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", { detail: { key: "userStatus" } }),
      );
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

      testPrefs.set("callSounds", false);
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", { detail: { key: "callSounds" } }),
      );
      vi.advanceTimersByTime(6_000);
      expect(frequencies).not.toContain(440);

      testPrefs.set("callSounds", true);
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", { detail: { key: "callSounds" } }),
      );
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
