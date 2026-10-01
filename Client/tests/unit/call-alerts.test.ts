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
const { startRingChime, stopRingChime, playNotificationSound } =
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
  setChannelMutesHost(null);
  vi.restoreAllMocks();
});

describe("an incoming call", () => {
  it("the ring calls the notifier's call notification and the attention request", () => {
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
