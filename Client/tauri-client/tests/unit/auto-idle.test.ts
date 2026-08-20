import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ACTIVITY_THROTTLE_MS,
  AUTO_IDLE_DELAY_MS,
  nextAutoStatus,
  startAutoIdle,
  type AutoIdleController,
} from "@lib/autoIdle";
import { loadUserStatus, loadUserStatusOrigin, saveUserStatus } from "@lib/userStatus";

/**
 * Auto-idle. The rule worth locking down is the narrow one: the timer may only
 * move a status it is itself responsible for. Everything else — a manually
 * chosen Idle, Do Not Disturb, Invisible — has to survive both the ten-minute
 * timeout and the mouse moving again.
 */

/** A minimal event target the controller can listen on, so the tests don't
 *  have to dispatch through jsdom's window and hope. */
function createTarget(): Pick<Window, "addEventListener" | "removeEventListener"> & {
  fire(): void;
} {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, fn: EventListenerOrEventListenerObject, opts?: unknown): void {
      const set = listeners.get(type) ?? new Set();
      set.add(fn as EventListener);
      listeners.set(type, set);
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => set.delete(fn as EventListener));
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject): void {
      listeners.get(type)?.delete(fn as EventListener);
    },
    fire(): void {
      for (const fn of listeners.get("mousemove") ?? []) fn(new Event("mousemove"));
    },
  } as never;
}

describe("nextAutoStatus", () => {
  it("only turns a manual Online into Idle", () => {
    expect(nextAutoStatus("online", "manual", true)).toBe("idle");
    // A manually chosen Idle is a statement — there is nothing to promote.
    expect(nextAutoStatus("idle", "manual", true)).toBeNull();
    expect(nextAutoStatus("idle", "auto", true)).toBeNull();
  });

  it("never touches Do Not Disturb or Invisible", () => {
    for (const status of ["dnd", "invisible"] as const) {
      expect(nextAutoStatus(status, "manual", true)).toBeNull();
      expect(nextAutoStatus(status, "manual", false)).toBeNull();
      // Even if some path had marked them automatic, they stay put.
      expect(nextAutoStatus(status, "auto", true)).toBeNull();
      expect(nextAutoStatus(status, "auto", false)).toBeNull();
    }
  });

  it("only undoes an Idle it set itself", () => {
    expect(nextAutoStatus("idle", "auto", false)).toBe("online");
    // The user picked Idle; coming back to the keyboard is not a request to
    // leave it.
    expect(nextAutoStatus("idle", "manual", false)).toBeNull();
    expect(nextAutoStatus("online", "manual", false)).toBeNull();
  });
});

describe("startAutoIdle", () => {
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

  it("flips a manual Online to Idle after the delay", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    controller = startAutoIdle({ onStatusChange, target: createTarget() });

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS - 1);
    expect(onStatusChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
    expect(loadUserStatus()).toBe("idle");
    // Marked automatic, which is what lets the return-to-activity path know it
    // is undoing its own work rather than a choice.
    expect(loadUserStatusOrigin()).toBe("auto");
  });

  it("returns to Online on the first input after going idle", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS);
    expect(onStatusChange).toHaveBeenLastCalledWith("idle");

    target.fire();
    expect(onStatusChange).toHaveBeenLastCalledWith("online");
    expect(loadUserStatus()).toBe("online");
    expect(loadUserStatusOrigin()).toBe("manual");
  });

  it("re-arms on activity so a busy user never goes idle", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    // Nudge the timer every half-delay for a few rounds.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS / 2);
      vi.setSystemTime(Date.now());
      target.fire();
    }
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS - 1);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("throttles the re-arm bookkeeping", () => {
    saveUserStatus("online");
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange: vi.fn(), target });

    // A burst of events inside the throttle window must not each restart the
    // ten-minute clock from their own moment — only the first one counts.
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS / 2);
    for (let i = 0; i < 50; i++) target.fire();

    // The clock is still the one armed at the (single) accepted activity, so
    // the flip still lands at the original deadline.
    expect(loadUserStatus()).toBe("online");
  });

  it("leaves a manually chosen Do Not Disturb alone in both directions", () => {
    saveUserStatus("dnd");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS * 3);
    target.fire();

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("dnd");
  });

  it("leaves a manually chosen Invisible alone", () => {
    saveUserStatus("invisible");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS * 2);
    target.fire();

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("invisible");
  });

  it("leaves a manually chosen Idle alone when the user comes back", () => {
    saveUserStatus("idle");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS);
    target.fire();

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("idle");
  });

  it("restores Online on activity when the controller starts from a persisted auto-idle state", () => {
    // Regression for v023: a session that starts already auto-idle (app
    // restart, MainPage remount) must still be un-idled by activity. The
    // in-memory latch used to start false regardless of the persisted
    // status/origin, so apply(false) was unreachable and the user broadcast
    // "idle" for the rest of the session no matter how much they used the app.
    saveUserStatus("idle", "auto");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    target.fire();

    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("online");
    expect(loadUserStatus()).toBe("online");
    expect(loadUserStatusOrigin()).toBe("manual");
  });

  it("stays armed after a firing that changed nothing, so a later external status change is still watched", () => {
    // Regression for OC-0236: the timer callback used to leave `timer` at
    // null forever after it fired once. That's invisible while the status
    // stays untouched between firings, but a surface that writes
    // saveUserStatus() directly instead of going through onActivity — the OS
    // tray's Status submenu, which delivers no DOM event into the webview —
    // can make the status eligible again (dnd -> online) without ever
    // re-arming the watcher. Without re-arming, the user then stays broadcast
    // as Online indefinitely.
    saveUserStatus("dnd");
    const onStatusChange = vi.fn();
    const target = createTarget();
    controller = startAutoIdle({ onStatusChange, target });

    // First firing: ineligible (dnd), apply(true) is a no-op.
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS);
    expect(onStatusChange).not.toHaveBeenCalled();

    // The tray writes the status directly — no DOM event, so onActivity/arm()
    // never runs on this path.
    saveUserStatus("online", "manual");

    // A further full delay of continued inactivity should now flip to idle,
    // exactly as it would have if "online" had been the status from the
    // start. That requires the timer to still be armed.
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
    expect(loadUserStatus()).toBe("idle");
    expect(loadUserStatusOrigin()).toBe("auto");
  });

  it("leaves no pending timer when destroy() is called synchronously from onStatusChange", () => {
    // The re-arm added for OC-0236 runs after apply(true), which invokes
    // onStatusChange synchronously. If that callback tears the page down and
    // calls destroy() from inside it, `timer` is already null at that point
    // (cleared before apply() ran), so destroy()'s own clearTimeout is a
    // no-op. Without re-checking `destroyed` before the re-arm, destroy()
    // would appear to work (no wrong status change ever fires, since the
    // handler's own top-of-body check still catches it) while actually
    // leaking a dangling timer that outlives the controller.
    saveUserStatus("online");
    const target = createTarget();
    const onStatusChange = vi.fn(() => {
      controller?.destroy();
      controller = null;
    });
    // Baseline first: the environment (jsdom/vitest) may hold timers of its
    // own that have nothing to do with this controller, so assert against a
    // delta rather than an absolute count of 0.
    const before = vi.getTimerCount();
    controller = startAutoIdle({ onStatusChange, target });
    expect(vi.getTimerCount()).toBe(before + 1);

    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
    expect(vi.getTimerCount()).toBe(before);
  });

  it("stops firing after destroy", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    controller = startAutoIdle({ onStatusChange, target: createTarget() });

    controller.destroy();
    controller = null;
    vi.advanceTimersByTime(AUTO_IDLE_DELAY_MS * 2);

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("honours an injected delay", () => {
    saveUserStatus("online");
    const onStatusChange = vi.fn();
    controller = startAutoIdle({ onStatusChange, target: createTarget(), delayMs: 5000 });

    vi.advanceTimersByTime(5000);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
  });
});
