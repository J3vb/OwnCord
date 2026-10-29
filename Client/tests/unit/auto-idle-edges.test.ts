import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_THROTTLE_MS,
  AUTO_IDLE_DELAY_MS,
  SYSTEM_IDLE_POLL_MS,
  nextAutoStatus,
  startAutoIdle,
  type AutoIdleController,
} from "../../src/lib/autoIdle";
import { loadUserStatus, saveUserStatus } from "../../src/lib/userStatus";

type Target = Pick<Window, "addEventListener" | "removeEventListener">;

/** A target that remembers what was registered, and fires the mouse listener. */
function recordingTarget() {
  const added: Array<{ type: string; options: unknown }> = [];
  const mouse: EventListener[] = [];
  const target: Target = {
    addEventListener(type: string, fn: EventListenerOrEventListenerObject, options?: unknown) {
      added.push({ type, options });
      if (type === "mousemove") mouse.push(fn as EventListener);
    },
    removeEventListener() {},
  };
  return {
    target,
    added,
    fire: () => {
      for (const fn of mouse) fn(new Event("mousemove"));
    },
  };
}

function ignoreAnswer(): void {}

let controller: AutoIdleController | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  controller?.destroy();
  controller = null;
  vi.useRealTimers();
});

describe("nextAutoStatus", () => {
  it("does not idle an Online that an automatic move put there", () => {
    expect(nextAutoStatus("online", "auto", true)).toBeNull();
    expect(nextAutoStatus("online", "manual", true)).toBe("idle");
  });
});

describe("activity throttle", () => {
  it("accepts an input exactly one throttle window after the last accepted one, and not before", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    const rec = recordingTarget();
    controller = startAutoIdle({ onStatusChange, target: rec.target });

    vi.advanceTimersByTime(5000);
    rec.fire(); // accepted: restarts the clock at 5 s
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS - 1);
    rec.fire(); // inside the window: ignored
    vi.advanceTimersByTime(1);
    rec.fire(); // exactly one window later: accepted, restarts the clock again

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS - 1);
    expect(onStatusChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
  });

  it("does not restart the clock for an input inside the window", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    const rec = recordingTarget();
    controller = startAutoIdle({ onStatusChange, target: rec.target });

    vi.advanceTimersByTime(5000);
    rec.fire();
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS / 2);
    rec.fire();
    // The clock still runs from the first accepted input.
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS - ACTIVITY_THROTTLE_MS / 2);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
  });
});

describe("coming back", () => {
  it("counts the next quiet period from the return, not from the moment it went idle", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    const rec = recordingTarget();
    controller = startAutoIdle({ onStatusChange, target: rec.target });

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS);
    expect(loadUserStatus()).toBe("idle");
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS / 2);
    rec.fire();
    expect(loadUserStatus()).toBe("online");

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS / 2 + 1);
    expect(loadUserStatus()).toBe("online");
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS / 2);
    expect(loadUserStatus()).toBe("idle");
  });

  it("stops treating input as a return once the status was changed by hand", () => {
    saveUserStatus("idle", "auto");
    const onStatusChange = vi.fn();
    const rec = recordingTarget();
    controller = startAutoIdle({ onStatusChange, target: rec.target });

    // The member picks Online from another surface, then moves the mouse twice
    // inside one throttle window: only the first counts.
    saveUserStatus("online", "manual");
    vi.advanceTimersByTime(5000);
    rec.fire();
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS / 2);
    rec.fire();
    expect(onStatusChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS - ACTIVITY_THROTTLE_MS / 2);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
  });
});

describe("listeners and teardown", () => {
  it("listens passively for every kind of input, owned by one signal that teardown aborts", () => {
    const rec = recordingTarget();
    controller = startAutoIdle({ onStatusChange: vi.fn(), target: rec.target });
    expect(rec.added.map((a) => a.type)).toEqual([
      "mousemove",
      "mousedown",
      "keydown",
      "wheel",
      "touchstart",
    ]);
    const signals = rec.added.map((a) => (a.options as { signal: AbortSignal }).signal);
    for (const a of rec.added) {
      expect(a.options).toMatchObject({ passive: true });
    }
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]!.aborted).toBe(false);
    controller.destroy();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("leaves no timer behind, and ignores reported activity once destroyed", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    controller = startAutoIdle({ onStatusChange, target: recordingTarget().target });
    expect(vi.getTimerCount()).toBe(1);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
    controller.notifyActivity();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS * 2);
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("online");
  });

  it("clears the poll timer too", () => {
    controller = startAutoIdle({
      onStatusChange: vi.fn(),
      target: recordingTarget().target,
      systemIdleMs: () => Promise.resolve(0),
    });
    expect(vi.getTimerCount()).toBe(2);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("OS idle source", () => {
  it("asks one question at a time while an answer is pending", async () => {
    let answer: (ms: number | null) => void = ignoreAnswer;
    const systemIdleMs = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          answer = resolve;
        }),
    );
    controller = startAutoIdle({
      onStatusChange: vi.fn(),
      target: recordingTarget().target,
      systemIdleMs,
    });
    await vi.advanceTimersByTimeAsync(SYSTEM_IDLE_POLL_MS * 3);
    expect(systemIdleMs).toHaveBeenCalledTimes(1);
    answer(0);
    await vi.advanceTimersByTimeAsync(SYSTEM_IDLE_POLL_MS);
    expect(systemIdleMs).toHaveBeenCalledTimes(2);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "treats %s as the OS not knowing, so the quiet timer decides",
    async (answer) => {
      saveUserStatus("online");
      controller = startAutoIdle({
        onStatusChange: vi.fn(),
        target: recordingTarget().target,
        systemIdleMs: () => Promise.resolve(answer),
      });
      await vi.advanceTimersByTimeAsync(SYSTEM_IDLE_POLL_MS * 2);
      expect(loadUserStatus()).toBe("online");
      await vi.advanceTimersByTimeAsync(AUTO_IDLE_DELAY_MS);
      expect(loadUserStatus()).toBe("idle");
    },
  );
});
