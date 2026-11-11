import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dataSaverActive,
  dataSaverPreference,
} from "../../../../../src/features/messaging/content/dataSaver";
import { savePref } from "../../../../../src/lib/prefs/preferences";
import { desktop } from "../../../../../src/platform/desktop";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("data saver preference", () => {
  it.each([
    ["off", false, false],
    ["off", true, false],
    ["mobile", false, false],
    ["mobile", true, true],
    ["always", false, true],
    ["always", true, true],
  ] as const)("%s with metered=%s is active=%s", (pref, metered, active) => {
    savePref("dataSaver", pref);
    vi.spyOn(desktop.meteredNetwork, "isMetered").mockReturnValue(metered);
    expect(dataSaverActive()).toBe(active);
  });

  it("defaults to off and rejects unknown stored choices", () => {
    expect(dataSaverPreference()).toBe("off");
    savePref("dataSaver", "unknown");
    expect(dataSaverActive()).toBe(false);
    expect(dataSaverPreference()).toBe("off");
  });
});
