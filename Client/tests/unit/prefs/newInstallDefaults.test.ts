import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_PREFIX } from "../../../src/lib/prefs/preferences";
import { hasInstallEvidence } from "../../../src/lib/prefs/installEvidence";
import { settleNewInstallDefaults } from "../../../src/lib/prefs/newInstallDefaults";
import { loadScreenLayout, SCREEN_LAYOUT_PREF } from "../../../src/lib/prefs/screenLayout";
import {
  getActiveThemeName,
  NEW_INSTALL_THEME,
  recordNewInstallTheme,
} from "../../../src/lib/prefs/themes";
import { settleNotificationLevelDefault } from "../../../src/lib/prefs/notificationLevel";
import { clearLocalStoragePreservingUserData } from "../../../src/features/settings/AdvancedCache";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";
import { expectConsole } from "../../helpers/console";

const LAYOUT_KEY = STORAGE_PREFIX + SCREEN_LAYOUT_PREF;
const THEME_KEY = "owncord:theme:active";
const LEGACY_THEME_KEY = "owncord:settings:theme";

function snapshot(): Record<string, string> {
  return Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]));
}

/** One startup, as main.ts runs it: the evidence read once, then the settle. */
function boot(): void {
  settleNewInstallDefaults(hasInstallEvidence());
}

describe("settleNewInstallDefaults", () => {
  beforeEach(() => {
    localStorage.clear();
    hostDesktopApp();
  });
  afterEach(() => {
    clearHost();
    vi.restoreAllMocks();
  });

  it("starts a new desktop install on Gunmetal, then Command Deck", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    settleNewInstallDefaults(false);
    expect(setItem.mock.calls).toEqual([
      [THEME_KEY, "gunmetal"],
      [LAYOUT_KEY, JSON.stringify("deck")],
    ]);
    expect(NEW_INSTALL_THEME).toBe("gunmetal");
    expect(loadScreenLayout()).toBe("deck");
    expect(getActiveThemeName()).toBe("gunmetal");
  });

  it("starts a new browser install the same way", () => {
    clearHost();
    settleNewInstallDefaults(false);
    expect(snapshot()).toEqual({ [THEME_KEY]: "gunmetal", [LAYOUT_KEY]: '"deck"' });
  });

  it("gives a new Android install Gunmetal and no layout value", () => {
    hostAndroidApp();
    settleNewInstallDefaults(false);
    expect(snapshot()).toEqual({ [THEME_KEY]: "gunmetal" });
    expect(loadScreenLayout()).toBe("classic");
  });

  it("pins an install that ran before to Classic and leaves its theme alone", () => {
    localStorage.setItem("owncord:settings:notificationLevel", '"all"');
    localStorage.setItem(THEME_KEY, "light");
    settleNewInstallDefaults(true);
    expect(snapshot()).toEqual({
      "owncord:settings:notificationLevel": '"all"',
      [THEME_KEY]: "light",
      [LAYOUT_KEY]: '"classic"',
    });
  });

  it("does not give an earlier install without a theme key the new theme", () => {
    localStorage.setItem("owncord:settings:notificationLevel", '"all"');
    settleNewInstallDefaults(true);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(getActiveThemeName()).toBe("neon-glow");
    expect(loadScreenLayout()).toBe("classic");
  });

  it("writes nothing for an Android install that ran before", () => {
    hostAndroidApp();
    localStorage.setItem("owncord:settings:notificationLevel", '"all"');
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    settleNewInstallDefaults(true);
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['"classic"', false],
    ['"deck"', false],
    ['"classic"', true],
    ['"deck"', true],
    ["not json", false],
    ['"sideways"', true],
    ["", false],
  ])("writes nothing when a layout %j is stored (evidence %s)", (value, evidence) => {
    localStorage.setItem(LAYOUT_KEY, value);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    settleNewInstallDefaults(evidence);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(value);
  });

  it("reads a new install as new only once: a second launch changes nothing", () => {
    boot();
    settleNotificationLevelDefault(false);
    // What the rest of a session leaves behind.
    localStorage.setItem("owncord:settings:lastChannel:a.example", "3");
    const afterFirst = snapshot();
    expect(hasInstallEvidence()).toBe(true);
    boot();
    expect(snapshot()).toEqual(afterFirst);
    expect(loadScreenLayout()).toBe("deck");
    expect(getActiveThemeName()).toBe("gunmetal");
  });

  it.each(["classic", "deck"] as const)(
    "keeps %s through Clear all cache & restart and the next settle",
    (layout) => {
      localStorage.setItem(THEME_KEY, "midnight");
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      localStorage.setItem("owncord:settings:fontSize", "16");
      clearLocalStoragePreservingUserData();
      const kept = snapshot();
      boot();
      expect(snapshot()).toEqual(kept);
      expect(loadScreenLayout()).toBe(layout);
      expect(getActiveThemeName()).toBe("midnight");
    },
  );

  it("runs Classic and the old fallback theme when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    boot();
    expectConsole("warn", /\[preferences\] Failed to save preference/);
    expect(localStorage.length).toBe(0);
    expect(loadScreenLayout()).toBe("classic");
    expect(getActiveThemeName()).toBe("neon-glow");
  });
});

describe("recordNewInstallTheme", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("stores the new-install theme raw when no theme key exists", () => {
    recordNewInstallTheme();
    expect(localStorage.getItem(THEME_KEY)).toBe("gunmetal");
  });

  it.each([
    ["the active key", THEME_KEY, "light"],
    ["Match my computer", THEME_KEY, "system"],
    ["a corrupt active value", THEME_KEY, "no-such-theme"],
    ["an empty active value", THEME_KEY, ""],
    ["the legacy key", LEGACY_THEME_KEY, '"dark"'],
  ])("never replaces %s", (_name, key, value) => {
    localStorage.setItem(key, value);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    recordNewInstallTheme();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(value);
  });
});
