import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearHost, hostAndroidApp } from "../../../tests/helpers/androidHost";
import {
  SCREEN_LAYOUT_PREF,
  loadScreenLayout,
  loadStoredScreenLayout,
  runningScreenLayout,
  saveScreenLayout,
  setRunningScreenLayout,
} from "./screenLayout";

const KEY = "owncord:settings:screenLayout";
const DEV_KEY = "owncord:settings:developerMode";

describe("screenLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    clearHost();
    setRunningScreenLayout("classic");
  });

  it("names the pref", () => {
    expect(SCREEN_LAYOUT_PREF).toBe("screenLayout");
  });

  describe("loadScreenLayout", () => {
    it.each([
      ["absent", null, null, "classic"],
      ["the number 1", "1", null, "classic"],
      ['"xyz"', '"xyz"', null, "classic"],
      ['"deck" with Developer mode off', '"deck"', "false", "deck"],
      ['"deck" with Developer mode absent', '"deck"', null, "deck"],
      ['"deck" with Developer mode on', '"deck"', "true", "deck"],
      ['"classic" with Developer mode on', '"classic"', "true", "classic"],
    ])("%s gives %s", (_name, stored, dev, expected) => {
      if (stored !== null) localStorage.setItem(KEY, stored);
      if (dev !== null) localStorage.setItem(DEV_KEY, dev);
      expect(loadScreenLayout()).toBe(expected);
    });

    it("gives deck in the Android app with deck stored and Developer mode off", () => {
      localStorage.setItem(KEY, '"deck"');
      localStorage.setItem(DEV_KEY, "false");
      hostAndroidApp();
      expect(loadScreenLayout()).toBe("deck");
    });

    it("gives deck in the Android app with deck stored and Developer mode on", () => {
      localStorage.setItem(KEY, '"deck"');
      localStorage.setItem(DEV_KEY, "true");
      hostAndroidApp();
      expect(loadScreenLayout()).toBe("deck");
      expect(localStorage.getItem(KEY)).toBe('"deck"');
    });

    it("never rewrites the stored value as Developer mode flips", () => {
      localStorage.setItem(KEY, '"deck"');
      localStorage.setItem(DEV_KEY, "false");
      expect(loadScreenLayout()).toBe("deck");
      expect(localStorage.getItem(KEY)).toBe('"deck"');
      localStorage.setItem(DEV_KEY, "true");
      expect(loadScreenLayout()).toBe("deck");
      expect(localStorage.getItem(KEY)).toBe('"deck"');
    });
  });

  it("loadStoredScreenLayout ignores Developer mode", () => {
    localStorage.setItem(KEY, '"deck"');
    expect(loadStoredScreenLayout()).toBe("deck");
  });

  it("saveScreenLayout stores the JSON string", () => {
    saveScreenLayout("deck");
    expect(localStorage.getItem(KEY)).toBe('"deck"');
  });

  it("the running value starts classic and follows its setter", () => {
    expect(runningScreenLayout()).toBe("classic");
    setRunningScreenLayout("deck");
    expect(runningScreenLayout()).toBe("deck");
  });
});
