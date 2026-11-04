// Desktop binding for the WindowPrefs contract: the two native calls behind
// "Close to Tray" and "Start Minimized". A native failure must come back as a
// typed result, never as a rejection the settings tab has to catch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as lm from "../../helpers/loggerMock";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => lm.loggerMock());

const { windowPrefs } = await import("../../../src/platform/desktop/windowPrefs");

describe("windowPrefs (desktop)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("reads both values from get_window_prefs", async () => {
    invoke.mockResolvedValue({ minimizeToTray: true, startMinimized: false });
    await expect(windowPrefs.load()).resolves.toEqual({
      minimizeToTray: true,
      startMinimized: false,
    });
    expect(invoke).toHaveBeenCalledWith("get_window_prefs");
  });

  it("answers null when the host rejects", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    await expect(windowPrefs.load()).resolves.toBeNull();
  });

  it("answers null for a payload that is not both booleans", async () => {
    for (const payload of [undefined, null, "x", {}, { minimizeToTray: true }]) {
      invoke.mockResolvedValue(payload);
      await expect(windowPrefs.load()).resolves.toBeNull();
    }
  });

  it("saves one preference through set_window_pref", async () => {
    invoke.mockResolvedValue(undefined);
    await expect(windowPrefs.set("startMinimized", true)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_window_pref", {
      pref: "startMinimized",
      enabled: true,
    });
  });

  it("answers false, without throwing, when the save fails", async () => {
    invoke.mockRejectedValue("disk full");
    await expect(windowPrefs.set("minimizeToTray", false)).resolves.toBe(false);
  });
});
