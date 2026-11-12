// The Android app's side of `systemIdle.follow`: it listens for the plugin's
// `look`, gives the plugin the delay, and takes that back when it stops.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Disposable } from "../../../../src/lib/disposable";
import type { SystemIdle } from "../../../../src/platform/contracts/systemIdle";
import { createDeferred } from "../../../helpers/deferred";

const native = vi.hoisted(() => ({
  android: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unregister: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => native.android }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ warn: native.warn, debug: vi.fn() }),
}));
// The real `tryInvoke` and `invokeOrThrow` stay in.
vi.mock("@tauri-apps/api/core", () => ({
  addPluginListener: native.listen,
  invoke: native.invoke,
}));

const DELAY = 600_000;

/** Let the host side load and every answer land. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

async function load(): Promise<SystemIdle> {
  return (await import("../../../../src/platform/desktop/systemIdle")).systemIdle;
}

/** The delays the plugin was given, in the order it got them. */
function delays(): unknown[] {
  return native.invoke.mock.calls
    .filter(([command]) => command === "system_idle_follow")
    .map(([, args]) => (args as { thresholdMs: number }).thresholdMs);
}

let owner: Disposable;
/** The plugin's `look` event, as each follower registered for it. */
let look: (() => void)[];
let ask: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  owner = new Disposable();
  look = [];
  ask = vi.fn<() => void>();
  native.android = true;
  native.unregister.mockResolvedValue(undefined);
  native.listen.mockImplementation((_plugin: string, _event: string, handler: () => void) => {
    look.push(handler);
    return Promise.resolve({ unregister: native.unregister });
  });
  native.invoke.mockResolvedValue(null);
});
afterEach(() => owner.destroy());

describe("system idle time", () => {
  it("is read from the host, on the Android app as on the desktop", async () => {
    native.invoke.mockResolvedValue(42_000);
    const systemIdle = await load();
    await expect(systemIdle.idleMs()).resolves.toBe(42_000);
    native.android = false;
    await expect(systemIdle.idleMs()).resolves.toBe(42_000);
    expect(native.invoke.mock.calls).toEqual([["system_idle_ms"], ["system_idle_ms"]]);
  });
});

describe("following the idle time", () => {
  it("neither listens nor invokes off the Android app", async () => {
    native.android = false;
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    expect(native.listen).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("listens first, then gives the plugin the delay and reads once", async () => {
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    expect(native.listen).toHaveBeenCalledWith("owncord-idle", "look", expect.any(Function));
    expect(native.invoke.mock.calls).toEqual([["system_idle_follow", { thresholdMs: DELAY }]]);
    expect(native.listen.mock.invocationCallOrder[0]).toBeLessThan(
      native.invoke.mock.invocationCallOrder[0]!,
    );
    expect(ask).toHaveBeenCalledOnce();
  });

  it("asks at each look", async () => {
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    look[0]!();
    look[0]!();
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("stops with its owner: it unlistens, ends the plugin's delay and asks no more", async () => {
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    owner.destroy();
    await settle();
    expect(native.unregister).toHaveBeenCalledOnce();
    expect(delays()).toEqual([DELAY, 0]);
    look[0]!();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("an owner gone before the listener is in leaves no listener, no delay and no read", async () => {
    const listening = createDeferred<{ unregister: () => Promise<void> }>();
    native.listen.mockReturnValue(listening.promise);
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    owner.destroy();
    listening.resolve({ unregister: native.unregister });
    await settle();
    expect(native.unregister).toHaveBeenCalledOnce();
    expect(delays()).toEqual([0]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("a newer follower takes over: the older one's looks and its end change nothing", async () => {
    const systemIdle = await load();
    const older = new Disposable();
    const olderAsk = vi.fn<() => void>();
    systemIdle.follow(older.signal, DELAY, olderAsk);
    await settle();
    systemIdle.follow(owner.signal, 2 * DELAY, ask);
    await settle();
    olderAsk.mockClear();
    ask.mockClear();

    look[0]!();
    look[1]!();
    expect(olderAsk).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledOnce();

    older.destroy();
    await settle();
    expect(delays()).toEqual([DELAY, 2 * DELAY]);
  });

  it("a follower whose owner is gone already takes nothing over", async () => {
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    const gone = new Disposable();
    gone.destroy();
    systemIdle.follow(gone.signal, 2 * DELAY, vi.fn<() => void>());
    await settle();
    expect(native.listen).toHaveBeenCalledOnce();
    expect(delays()).toEqual([DELAY]);
    look[0]!();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("gives the plugin one delay at a time, in the order they were made", async () => {
    const first = createDeferred<null>();
    native.invoke.mockReturnValueOnce(first.promise);
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    owner.destroy();
    await settle();
    // The end waits for the start to be answered: sent together, the two
    // could reach the plugin either way round.
    expect(delays()).toEqual([DELAY]);
    first.resolve(null);
    await settle();
    expect(delays()).toEqual([DELAY, 0]);
  });

  it("a refused delay is logged and does not hold up the next", async () => {
    native.invoke.mockRejectedValueOnce("no plugin");
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    expect(native.warn).toHaveBeenCalledWith("system_idle_follow failed", "no plugin");
    owner.destroy();
    await settle();
    expect(delays()).toEqual([DELAY, 0]);
  });

  it("without the plugin's events it gives no delay and reads nothing", async () => {
    native.listen.mockRejectedValue(new Error("not allowed"));
    const systemIdle = await load();
    systemIdle.follow(owner.signal, DELAY, ask);
    await settle();
    expect(native.warn).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});
