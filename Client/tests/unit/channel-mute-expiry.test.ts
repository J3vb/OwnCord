import { startMuteExpiryWatch } from "@lib/prefs/channelMuteExpiry";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CHANNEL_MUTE_CHANGED,
  getChannelMute,
  invalidateMuteCache,
  isChannelMuted,
  muteChannel,
  setChannelMutesHost,
  unmuteChannel,
} from "@lib/prefs/channelMutes";
import { STORAGE_PREFIX } from "@lib/prefs/preferences";

const KEY = `${STORAGE_PREFIX}mutedChannels`;
const T0 = new Date(2026, 9, 17, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 3_600_000;

let ac: AbortController;
let announced: number[];
let stop: (() => void) | null;

beforeEach(() => {
  localStorage.clear();
  setChannelMutesHost(null);
  invalidateMuteCache();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  ac = new AbortController();
  announced = [];
  stop = null;
  window.addEventListener(
    CHANNEL_MUTE_CHANGED,
    (e) => announced.push((e as CustomEvent<{ channelId: number }>).detail.channelId),
    { signal: ac.signal },
  );
});

afterEach(() => {
  stop?.();
  ac.abort();
  vi.useRealTimers();
});

function start(): void {
  stop = startMuteExpiryWatch();
}

describe("timed mute expiry watcher", () => {
  it("watcher fires at expiry and announces so the row redraws un-dimmed", () => {
    muteChannel(5, 900_000);
    start();
    announced.length = 0;

    vi.advanceTimersByTime(14 * MIN);
    expect(isChannelMuted(5)).toBe(true);
    expect(announced).toEqual([]);

    vi.advanceTimersByTime(MIN + 1);
    expect(announced).toEqual([5]);
    expect(isChannelMuted(5)).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
    // Nothing left to watch.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delay is capped at 60 s", () => {
    muteChannel(5, 86_400_000);
    start();
    const spy = vi.spyOn(globalThis, "setTimeout");
    // Force a re-arm and look at the delay it asked for.
    muteChannel(6, 86_400_000);
    const delays = spy.mock.calls.map((c) => c[1]);
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...(delays as number[]))).toBeLessThanOrEqual(60_000);
    expect(vi.getTimerCount()).toBe(1);
    spy.mockRestore();
  });

  it("keeps re-arming in 60 s steps and still ends the mute on time", () => {
    muteChannel(5, 3 * HOUR);
    start();
    vi.advanceTimersByTime(3 * HOUR - MIN);
    expect(isChannelMuted(5)).toBe(true);
    vi.advanceTimersByTime(MIN + 1);
    expect(getChannelMute(5)).toBeNull();
    expect(announced.filter((id) => id === 5).length).toBe(2); // mute + expiry
  });

  it("no timer armed with no timed mute", () => {
    start();
    expect(vi.getTimerCount()).toBe(0);
    muteChannel(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms when a timed mute is set after start", () => {
    start();
    muteChannel(5, 900_000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("start prunes mutes that expired while closed", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: 5, until: T0 - 1000 }, 6]));
    invalidateMuteCache();
    start();
    expect(announced).toEqual([5]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([6]);
  });

  // Edge case 1: the machine sleeps through an expiry.
  it("focus after a missed expiry prunes at once, and the gate was already right", () => {
    muteChannel(5, 900_000);
    start();
    announced.length = 0;

    // The lid is shut: the wall clock jumps, no timer runs.
    vi.setSystemTime(T0 + 2 * HOUR);
    // The read-time check does not wait for the watcher.
    expect(isChannelMuted(5)).toBe(false);
    // The row is still stored (and dimmed) until something looks.
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([{ id: 5, until: T0 + 900_000 }]);

    window.dispatchEvent(new Event("focus"));
    expect(announced).toEqual([5]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
  });

  it("becoming visible after a missed expiry prunes at once", () => {
    muteChannel(5, 900_000);
    start();
    announced.length = 0;
    vi.setSystemTime(T0 + 2 * HOUR);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(announced).toEqual([5]);
  });

  it("a clock moved back never leaves more than 24 h on a mute", () => {
    muteChannel(5, 86_400_000);
    start();
    vi.setSystemTime(T0 - 10 * HOUR);
    window.dispatchEvent(new Event("focus"));
    expect(getChannelMute(5)).toEqual({ until: T0 - 10 * HOUR + 24 * HOUR });
  });

  // Edge case 2: the mute changes while its timer is armed.
  it("changing the mute while armed never unmutes a forever mute and re-arms", () => {
    muteChannel(5, HOUR);
    start();
    muteChannel(5); // 1 h -> until turned back on
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(3 * HOUR);
    expect(isChannelMuted(5)).toBe(true);
    expect(getChannelMute(5)).toEqual({ until: null });

    // And the reverse: forever -> 15 min arms for the new expiry and ends it.
    muteChannel(5, 900_000);
    expect(vi.getTimerCount()).toBe(1);
    announced.length = 0;
    vi.advanceTimersByTime(15 * MIN + 1);
    expect(announced).toEqual([5]);
    expect(isChannelMuted(5)).toBe(false);
  });

  it("a mute shortened while armed ends at the new, earlier expiry", () => {
    muteChannel(5, HOUR);
    start();
    muteChannel(5, 900_000);
    announced.length = 0;
    vi.advanceTimersByTime(15 * MIN + 1);
    expect(announced).toEqual([5]);
  });

  it("an unmute while armed leaves no stale timer and no later announcement", () => {
    muteChannel(5, HOUR);
    start();
    unmuteChannel(5);
    announced.length = 0;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2 * HOUR);
    expect(announced).toEqual([]);
    expect(isChannelMuted(5)).toBe(false);
  });

  it("stop() leaves no timer or listener", () => {
    muteChannel(5, HOUR);
    start();
    expect(vi.getTimerCount()).toBe(1);
    stop!();
    stop = null;
    expect(vi.getTimerCount()).toBe(0);

    // A listener left behind would prune this on focus/visibility/change.
    localStorage.setItem(KEY, JSON.stringify([{ id: 9, until: T0 - 1000 }]));
    invalidateMuteCache();
    announced.length = 0;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new CustomEvent(CHANNEL_MUTE_CHANGED, { detail: { channelId: 1 } }));
    expect(vi.getTimerCount()).toBe(0);
    expect(announced).toEqual([1]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([{ id: 9, until: T0 - 1000 }]);
  });

  it("mutes on host A are never pruned or announced under host B", () => {
    setChannelMutesHost("a.example.com");
    muteChannel(5, 900_000);
    setChannelMutesHost("b.example.com");
    start();
    announced.length = 0;
    vi.advanceTimersByTime(HOUR);
    expect(announced).toEqual([]);
    setChannelMutesHost("a.example.com");
    expect(getChannelMute(5)).toBeNull(); // ended, but only A's read says so
    setChannelMutesHost(null);
  });
});
