import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ android: true }));
vi.mock("../../lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));

const { askNotificationPermissionOnce } = await import("./permissionAsk");
const { loadPref, savePref } = await import("../../lib/prefs/preferences");
const { expectConsole } = await import("../../../tests/helpers/console");

const notifier = {
  permissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<boolean>>(),
};

beforeEach(() => {
  host.android = true;
  localStorage.clear();
  notifier.permissionGranted.mockReset().mockResolvedValue(false);
  notifier.requestPermission.mockReset().mockResolvedValue(false);
});

describe("askNotificationPermissionOnce", () => {
  it("asks once after sign-in, and never again after a refusal", async () => {
    await askNotificationPermissionOnce(notifier);
    await askNotificationPermissionOnce(notifier);
    expect(notifier.requestPermission).toHaveBeenCalledTimes(1);
    expect(loadPref("notificationPermissionAsked", false)).toBe(true);
  });

  it("does not ask for a permission already held, and keeps its one ask", async () => {
    notifier.permissionGranted.mockResolvedValue(true);
    await askNotificationPermissionOnce(notifier);
    expect(notifier.requestPermission).not.toHaveBeenCalled();
    expect(loadPref("notificationPermissionAsked", false)).toBe(false);
  });

  it("never asks on the desktop or in a browser", async () => {
    host.android = false;
    await askNotificationPermissionOnce(notifier);
    expect(notifier.permissionGranted).not.toHaveBeenCalled();
    expect(notifier.requestPermission).not.toHaveBeenCalled();
  });

  it("does not ask when it already did", async () => {
    savePref("notificationPermissionAsked", true);
    await askNotificationPermissionOnce(notifier);
    expect(notifier.permissionGranted).not.toHaveBeenCalled();
  });

  it("logs, and does not throw, when the host cannot be asked", async () => {
    notifier.permissionGranted.mockRejectedValue(new Error("no host"));
    await expect(askNotificationPermissionOnce(notifier)).resolves.toBeUndefined();
    expectConsole("warn", /Notification permission not asked/);
  });
});
