// The registry's Android notifier loads the real one on first use, and the
// desktop registry picks it only in the Android app.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Notifier, NotificationTarget } from "../../../src/platform/contracts/notifications";

const real = vi.hoisted(() => ({
  showMessage: vi.fn(async () => undefined),
  clearMessages: vi.fn(async () => undefined),
  permissionGranted: vi.fn(async () => true),
  stop: vi.fn(),
  handler: null as ((target: NotificationTarget) => void) | null,
}));
const host = vi.hoisted(() => ({ android: false }));

vi.mock("../../../src/platform/desktop/androidNotifications", () => ({
  androidNotifier: {
    showMessage: real.showMessage,
    clearMessages: real.clearMessages,
    permissionGranted: real.permissionGranted,
    onMessageActivated(handler: (target: NotificationTarget) => void) {
      real.handler = handler;
      return real.stop;
    },
  },
}));
vi.mock("../../../src/lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));
// The registry is imported afresh per host; the real logger would add a pref
// listener at every import.
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("lazy Android notifier", () => {
  let lazy: Notifier;
  beforeEach(async () => {
    real.stop.mockClear();
    real.handler = null;
    ({ androidNotifier: lazy } = await import("../../../src/platform/desktop/androidNotifierLazy"));
  });

  it("forwards each call to the real notifier", async () => {
    const target = { host: "h", channelId: 7, messageId: 1 };
    await lazy.showMessage("t", "b", target);
    await lazy.clearMessages(7);
    await expect(lazy.permissionGranted()).resolves.toBe(true);
    expect(real.showMessage).toHaveBeenCalledWith("t", "b", target);
    expect(real.clearMessages).toHaveBeenCalledWith(7);
    expect(lazy.readsOsPermission).toBe(true);
  });

  it("subscribes once loaded and unsubscribes through the real notifier", async () => {
    const handler = vi.fn();
    const stop = lazy.onMessageActivated(handler);
    await flush();
    real.handler?.({ host: "h", channelId: 3 });
    expect(handler).toHaveBeenCalledWith({ host: "h", channelId: 3 });
    stop();
    expect(real.stop).toHaveBeenCalledTimes(1);
  });

  it("never subscribes when unsubscribed before loading finished", async () => {
    const stop = lazy.onMessageActivated(vi.fn());
    stop();
    await flush();
    expect(real.handler).toBeNull();
  });
});

describe("desktop registry", () => {
  beforeEach(() => vi.resetModules());

  it("uses the Android notifier in the Android app", async () => {
    host.android = true;
    const { desktop } = await import("../../../src/platform/desktop");
    const { androidNotifier } = await import("../../../src/platform/desktop/androidNotifierLazy");
    expect(desktop.notifier).toBe(androidNotifier);
  });

  it("keeps the desktop notifier everywhere else", async () => {
    host.android = false;
    const { desktop } = await import("../../../src/platform/desktop");
    const { notifier } = await import("../../../src/platform/desktop/notifications");
    expect(desktop.notifier).toBe(notifier);
  });
});
