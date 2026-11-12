// A platform that says when its idle time is worth reading at once, instead
// of leaving it to the poll: the Android app does when it comes back into
// view, and when it has been out of view for the delay on a phone that sleeps
// and so runs neither the poll nor the timer.
import { describe, expect, it, vi } from "vitest";
import {
  AUTO_IDLE_DELAY_MS,
  SYSTEM_IDLE_POLL_MS,
  startAutoIdle,
  type AutoIdleController,
} from "../../src/lib/presence/autoIdle";
import {
  loadUserStatus,
  loadUserStatusOrigin,
  saveUserStatus,
} from "../../src/lib/presence/userStatus";
import { createDeferred } from "../helpers/deferred";
import { useFakeClockAndStorage } from "../helpers/withFakeTimers";

/** No input reaches the app in these tests. */
const noInput = { addEventListener() {}, removeEventListener() {} };

interface Follower {
  readonly signal: AbortSignal;
  readonly thresholdMs: number;
  readonly ask: () => void;
}

let controller: AutoIdleController | null = null;
let follower: Follower | null = null;
const onStatusChange = vi.fn();

useFakeClockAndStorage(() => {
  controller?.destroy();
  controller = null;
  follower = null;
  onStatusChange.mockReset();
});

/** Start the watcher on `idleMs`, and hand back what the platform was given. */
function follow(idleMs: () => Promise<number | null>): Follower {
  controller = startAutoIdle({
    onStatusChange,
    target: noInput,
    systemIdleMs: idleMs,
    followSystemIdle: (signal, thresholdMs, ask) => {
      follower = { signal, thresholdMs, ask };
    },
  });
  if (follower === null) throw new Error("the platform was not asked to follow");
  return follower;
}

/** Let an answer land without moving the poll's clock. */
const landed = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

describe("a platform that follows the idle time", () => {
  it("is given the idle delay, and a signal that teardown aborts", () => {
    const { signal, thresholdMs } = follow(async () => 0);

    expect(thresholdMs).toBe(AUTO_IDLE_DELAY_MS);
    expect(signal.aborted).toBe(false);
    controller?.destroy();
    expect(signal.aborted).toBe(true);
  });

  it("is not asked to follow when there is no idle time to read", () => {
    const followSystemIdle = vi.fn();
    controller = startAutoIdle({ onStatusChange, target: noInput, followSystemIdle });

    expect(followSystemIdle).not.toHaveBeenCalled();
  });

  it("goes idle as soon as the platform asks, without waiting for the poll", async () => {
    saveUserStatus("online");
    const idleMs = vi.fn(async () => AUTO_IDLE_DELAY_MS);
    const { ask } = follow(idleMs);

    ask();
    await landed();

    expect(idleMs).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
    expect(loadUserStatusOrigin()).toBe("auto");
  });

  it("comes back online as soon as the platform asks with the app back in view", async () => {
    saveUserStatus("online");
    let away = AUTO_IDLE_DELAY_MS + 5 * 60_000;
    const { ask } = follow(async () => away);
    ask();
    await landed();
    expect(loadUserStatus()).toBe("idle");

    away = 0;
    ask();
    await landed();

    expect(onStatusChange).toHaveBeenLastCalledWith("online");
    expect(loadUserStatusOrigin()).toBe("manual");
  });

  it("drops an answer asked for before the platform spoke, and reads again", async () => {
    saveUserStatus("online");
    const stale = createDeferred<number | null>();
    const idleMs = vi
      .fn<() => Promise<number | null>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(0);
    const { ask } = follow(idleMs);

    // The read goes out while the app is out of view; the app comes back
    // before its answer does.
    ask();
    ask();
    stale.resolve(AUTO_IDLE_DELAY_MS);
    await landed();

    expect(idleMs).toHaveBeenCalledTimes(2);
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("online");
  });

  it("reads again too when the platform speaks while the poll's read is out", async () => {
    saveUserStatus("online");
    const stale = createDeferred<number | null>();
    const idleMs = vi
      .fn<() => Promise<number | null>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(AUTO_IDLE_DELAY_MS);
    const { ask } = follow(idleMs);
    await vi.advanceTimersByTimeAsync(SYSTEM_IDLE_POLL_MS);
    expect(idleMs).toHaveBeenCalledOnce();

    ask();
    stale.resolve(0);
    await landed();

    expect(idleMs).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("idle");
  });

  it("keeps someone who just spoke in a call online when the platform asks", async () => {
    saveUserStatus("online");
    const { ask } = follow(async () => AUTO_IDLE_DELAY_MS * 2);
    controller?.notifyActivity();
    await vi.advanceTimersByTimeAsync(60_000);

    ask();
    await landed();

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("reads nothing for a platform that asks after teardown", async () => {
    const idleMs = vi.fn(async () => AUTO_IDLE_DELAY_MS);
    const { ask } = follow(idleMs);
    controller?.destroy();

    ask();
    await landed();

    expect(idleMs).not.toHaveBeenCalled();
  });
});
