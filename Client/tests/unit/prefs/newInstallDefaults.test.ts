import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_PREFIX } from "../../../src/lib/prefs/preferences";
import { hasInstallEvidence } from "../../../src/lib/prefs/installEvidence";
import {
  settleNewInstallDefaults,
  settleStartupLayout,
} from "../../../src/lib/prefs/newInstallDefaults";
import { DECK_NOTICE_PREF, DECK_SWITCH_PREF } from "../../../src/lib/prefs/deckSwitch";
import {
  loadScreenLayout,
  saveScreenLayout,
  SCREEN_LAYOUT_PREF,
} from "../../../src/lib/prefs/screenLayout";
import {
  getActiveThemeName,
  NEW_INSTALL_THEME,
  recordNewInstallTheme,
} from "../../../src/lib/prefs/themes";
import { settleNotificationLevelDefault } from "../../../src/lib/prefs/notificationLevel";
import { clearLocalStoragePreservingUserData } from "../../../src/features/settings/AdvancedCache";
import { deckNoticePending } from "../../../src/features/layout-notice/layoutNotice";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";
import { expectConsole } from "../../helpers/console";
import { usePhone } from "../../helpers/phoneMedia";

const LAYOUT_KEY = STORAGE_PREFIX + SCREEN_LAYOUT_PREF;
const THEME_KEY = "owncord:theme:active";
const LEGACY_THEME_KEY = "owncord:settings:theme";

function snapshot(): Record<string, string> {
  return Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]));
}

/** One startup, as main.ts runs it: the evidence read once, then the settles. */
function boot(): void {
  settleStartupLayout(hasInstallEvidence());
}
const MARKER_KEY = "owncord:settings:deckSwitchDone";
const NOTICE_KEY = "owncord:settings:deckSwitchNotice";
const LEVEL_KEY = "owncord:settings:notificationLevel";

/** Each case starts on an empty desktop profile and leaves no stub behind. */
function useEmptyDesktop(): void {
  beforeEach(() => {
    localStorage.clear();
    hostDesktopApp();
  });
  afterEach(() => {
    clearHost();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

describe("settleNewInstallDefaults", () => {
  useEmptyDesktop();

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

  it("starts a new phone-sized browser on Gunmetal and stores Command Deck", () => {
    clearHost();
    usePhone();
    settleNewInstallDefaults(false);
    expect(snapshot()).toEqual({ [THEME_KEY]: "gunmetal", [LAYOUT_KEY]: '"deck"' });
  });

  it("starts a new Android install on Command Deck and keeps its theme", () => {
    hostAndroidApp();
    settleNewInstallDefaults(false);
    expect(snapshot()).toEqual({ [LAYOUT_KEY]: '"deck"' });
    expect(getActiveThemeName()).toBe("neon-glow");
    expect(loadScreenLayout()).toBe("deck");
  });

  it("leaves an install that ran before, and its theme, alone", () => {
    localStorage.setItem("owncord:settings:notificationLevel", '"all"');
    localStorage.setItem(THEME_KEY, "light");
    settleNewInstallDefaults(true);
    expect(snapshot()).toEqual({
      "owncord:settings:notificationLevel": '"all"',
      [THEME_KEY]: "light",
    });
  });

  it("does not give an earlier install without a theme key the new theme", () => {
    localStorage.setItem("owncord:settings:notificationLevel", '"all"');
    settleNewInstallDefaults(true);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(getActiveThemeName()).toBe("neon-glow");
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
      localStorage.setItem(MARKER_KEY, "true");
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

/** An install that ran an earlier release: a level and a theme it chose. */
function earlierInstall(layout: string | null): void {
  localStorage.setItem(LEVEL_KEY, '"all"');
  localStorage.setItem(THEME_KEY, "light");
  if (layout !== null) localStorage.setItem(LAYOUT_KEY, layout);
}

/** What the move left: the layout, a pending notice, and the marker. */
function expectSettled(layout: "classic" | "deck", notice: boolean): void {
  expect(loadScreenLayout()).toBe(layout);
  expect(localStorage.getItem(NOTICE_KEY)).toBe(notice ? "true" : null);
  expect(localStorage.getItem(MARKER_KEY)).toBe("true");
}

describe("settleDeckSwitch", () => {
  useEmptyDesktop();

  it("names its prefs", () => {
    expect([DECK_SWITCH_PREF, DECK_NOTICE_PREF]).toEqual(["deckSwitchDone", "deckSwitchNotice"]);
  });

  it("moves an earlier install on Classic to Command Deck, keeps its theme, and asks for the notice", () => {
    earlierInstall('"classic"');
    boot();
    expectSettled("deck", true);
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('"deck"');
    expect(getActiveThemeName()).toBe("light");
    expect(deckNoticePending()).toBe(true);
  });

  it("moves an earlier install with no layout stored, as an Android one has", () => {
    hostAndroidApp();
    earlierInstall(null);
    boot();
    expect(loadScreenLayout()).toBe("deck");
    expect(getActiveThemeName()).toBe("light");
    expect(deckNoticePending()).toBe(true);
  });

  it("moves an earlier Android install on Classic too", () => {
    hostAndroidApp();
    earlierInstall('"classic"');
    boot();
    expect(loadScreenLayout()).toBe("deck");
    expect(deckNoticePending()).toBe(true);
  });

  it("leaves an earlier install already on Command Deck alone, with no notice", () => {
    earlierInstall('"deck"');
    boot();
    expectSettled("deck", false);
  });

  const phones: Array<[string, () => void]> = [
    ["a phone browser", () => (clearHost(), usePhone())],
    ["the Android app", () => hostAndroidApp()],
  ];

  it.each([["a desktop", () => hostDesktopApp()], ...phones] as Array<[string, () => void]>)(
    "starts a new install on %s on Command Deck with no notice",
    (_name, host) => {
      host();
      boot();
      expectSettled("deck", false);
    },
  );

  it.each(phones)("keeps a Classic already settled on %s, with no notice", (_name, host) => {
    host();
    earlierInstall('"classic"');
    localStorage.setItem(MARKER_KEY, "true");
    boot();
    expectSettled("classic", false);
    expect(getActiveThemeName()).toBe("light");
  });

  it("keeps a Classic seeded with nothing else, as the test harness seeds it", () => {
    localStorage.setItem(LAYOUT_KEY, '"classic"');
    boot();
    expectSettled("classic", false);
  });

  it("never moves someone again who went back to Classic, through restarts and Clear cache", () => {
    earlierInstall('"classic"');
    boot();
    localStorage.removeItem(NOTICE_KEY);
    saveScreenLayout("classic");
    boot();
    expect(loadScreenLayout()).toBe("classic");
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
    clearLocalStoragePreservingUserData();
    expect(localStorage.getItem(MARKER_KEY)).toBe("true");
    boot();
    expect(loadScreenLayout()).toBe("classic");
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
  });

  it("Clear all cache drops a notice not yet seen, and Command Deck stays", () => {
    earlierInstall('"classic"');
    boot();
    clearLocalStoragePreservingUserData();
    boot();
    expect(loadScreenLayout()).toBe("deck");
    expect(deckNoticePending()).toBe(false);
  });

  it("a cleared profile starts as a new install: Command Deck, no notice", () => {
    earlierInstall('"classic"');
    boot();
    localStorage.clear();
    boot();
    expect(loadScreenLayout()).toBe("deck");
    expect(deckNoticePending()).toBe(false);
  });

  it("moves no one and asks for no notice when storage cannot be written", () => {
    earlierInstall('"classic"');
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    boot();
    setItem.mockRestore();
    expect(loadScreenLayout()).toBe("classic");
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("moves no one and asks for no notice when storage cannot be read", () => {
    const blocked = (): never => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", new Proxy({}, { get: blocked, ownKeys: blocked }));
    boot();
    vi.unstubAllGlobals();
    expectConsole("warn", /\[preferences\] Failed to save preference/);
    expect(localStorage.length).toBe(0);
    expect(loadScreenLayout()).toBe("classic");
    expect(deckNoticePending()).toBe(false);
  });

  it("leaves the notice unasked when only the layout write succeeds and the rest fail", () => {
    earlierInstall('"classic"');
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key !== LAYOUT_KEY) throw new Error("quota");
      real.call(this, key, value);
    });
    boot();
    vi.restoreAllMocks();
    expect(loadScreenLayout()).toBe("deck");
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
    // The next start finds Command Deck stored: nothing more to move.
    boot();
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
    expect(localStorage.getItem(MARKER_KEY)).toBe("true");
  });

  it("the marker alone is not install evidence", () => {
    localStorage.setItem(MARKER_KEY, "true");
    localStorage.setItem(LAYOUT_KEY, '"classic"');
    expect(hasInstallEvidence()).toBe(false);
  });
});
