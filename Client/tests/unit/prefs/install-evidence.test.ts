import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_PREFIX } from "../../../src/lib/prefs/preferences";
import { SCREEN_LAYOUT_PREF } from "../../../src/lib/prefs/screenLayout";
import { hasInstallEvidence } from "../../../src/lib/prefs/installEvidence";

describe("hasInstallEvidence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("is false on empty storage", () => {
    expect(hasInstallEvidence()).toBe(false);
  });

  it("is false when only the screen layout key is stored", () => {
    localStorage.setItem(STORAGE_PREFIX + SCREEN_LAYOUT_PREF, '"classic"');
    expect(hasInstallEvidence()).toBe(false);
  });

  it("is true for the active theme key", () => {
    localStorage.setItem("owncord:theme:active", "gunmetal");
    expect(hasInstallEvidence()).toBe(true);
  });

  it("is true for the legacy theme key", () => {
    localStorage.setItem("owncord:theme", "dark");
    expect(hasInstallEvidence()).toBe(true);
  });

  it("is true for any other owncord key, with or without the layout key", () => {
    localStorage.setItem(STORAGE_PREFIX + SCREEN_LAYOUT_PREF, '"classic"');
    localStorage.setItem("owncord:settings:lastChannel:a.example", "3");
    expect(hasInstallEvidence()).toBe(true);
  });

  it("is false when only keys outside owncord: exist", () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("unrelated:thing", "1");
    expect(hasInstallEvidence()).toBe(false);
  });

  it("is false when storage cannot be read", () => {
    vi.spyOn(Object, "keys").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(hasInstallEvidence()).toBe(false);
  });

  it("leaves out exactly the screen layout key", () => {
    localStorage.setItem(`${STORAGE_PREFIX}${SCREEN_LAYOUT_PREF}`, '"deck"');
    expect(hasInstallEvidence()).toBe(false);
    localStorage.setItem(`${STORAGE_PREFIX}${SCREEN_LAYOUT_PREF}2`, "x");
    expect(hasInstallEvidence()).toBe(true);
  });
});
