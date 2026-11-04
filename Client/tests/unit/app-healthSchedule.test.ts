/**
 * The connect page's health refresh cadence (src/app/healthSchedule.ts):
 * quick for a minute, then slow, quiet while hidden or signing in. The two
 * edge cases: a hidden window skips its ticks and refreshes within 15 s of
 * being shown again; an aborted signal stops the timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_FAST_MS, HEALTH_SLOW_MS, scheduleHealthChecks } from "../../src/app/healthSchedule";

let hidden = false;
function setHidden(next: boolean): void {
  hidden = next;
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scheduleHealthChecks", () => {
  it("checks every 15 s for the first minute, then every 60 s", () => {
    const owner = new AbortController();
    const check = vi.fn();
    scheduleHealthChecks(owner.signal, check, () => false);
    vi.advanceTimersByTime(HEALTH_FAST_MS * 4);
    expect(check).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(HEALTH_FAST_MS * 3);
    expect(check).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(HEALTH_SLOW_MS - HEALTH_FAST_MS * 3);
    expect(check).toHaveBeenCalledTimes(5);
    owner.abort();
  });

  it("skips ticks while busy", () => {
    const owner = new AbortController();
    const check = vi.fn();
    let busy = true;
    scheduleHealthChecks(owner.signal, check, () => busy);
    vi.advanceTimersByTime(HEALTH_FAST_MS * 2);
    expect(check).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(HEALTH_FAST_MS);
    expect(check).toHaveBeenCalledTimes(1);
    owner.abort();
  });

  it("stays quiet while hidden and refreshes within 15 s of being shown again", () => {
    const owner = new AbortController();
    const check = vi.fn();
    scheduleHealthChecks(owner.signal, check, () => false);
    vi.advanceTimersByTime(HEALTH_SLOW_MS * 2);
    const before = check.mock.calls.length;
    setHidden(true);
    vi.advanceTimersByTime(HEALTH_SLOW_MS * 5);
    expect(check).toHaveBeenCalledTimes(before);
    setHidden(false);
    vi.advanceTimersByTime(HEALTH_FAST_MS);
    expect(check).toHaveBeenCalledTimes(before + 1);
    // The quick minute starts over from the return.
    vi.advanceTimersByTime(HEALTH_FAST_MS);
    expect(check).toHaveBeenCalledTimes(before + 2);
    owner.abort();
  });

  it("stops its timer once the signal aborts", () => {
    const owner = new AbortController();
    const check = vi.fn();
    scheduleHealthChecks(owner.signal, check, () => false);
    setHidden(true);
    vi.advanceTimersByTime(HEALTH_FAST_MS);
    owner.abort();
    expect(vi.getTimerCount()).toBe(0);
    setHidden(false);
    vi.advanceTimersByTime(HEALTH_SLOW_MS * 2);
    expect(check).not.toHaveBeenCalled();
  });
});
