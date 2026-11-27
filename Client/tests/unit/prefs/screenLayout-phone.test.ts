import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadScreenLayout, loadStoredScreenLayout } from "@lib/prefs/screenLayout";
import { PHONE_LAYOUT_QUERY } from "@lib/ui/phoneLayout";
import { clearHost } from "../../helpers/androidHost";

function stubPhone(phone: boolean): void {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: phone && media === PHONE_LAYOUT_QUERY,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("the screen layout on a phone", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("owncord:settings:screenLayout", '"deck"');
    localStorage.setItem("owncord:settings:developerMode", "true");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHost();
    localStorage.clear();
  });

  it("stored deck runs deck on a phone with Developer mode off", () => {
    localStorage.setItem("owncord:settings:developerMode", "false");
    stubPhone(true);
    expect(loadScreenLayout()).toBe("deck");
  });

  it("stored deck runs deck on a desktop with Developer mode", () => {
    stubPhone(false);
    expect(loadScreenLayout()).toBe("deck");
  });

  it("the stored value is untouched", () => {
    stubPhone(true);
    loadScreenLayout();
    expect(loadStoredScreenLayout()).toBe("deck");
    expect(localStorage.getItem("owncord:settings:screenLayout")).toBe('"deck"');
  });

  it("stored deck runs deck on a desktop with Developer mode never set", () => {
    localStorage.removeItem("owncord:settings:developerMode");
    stubPhone(false);
    expect(loadScreenLayout()).toBe("deck");
  });

  it("stored deck runs deck on a phone with Developer mode on", () => {
    stubPhone(true);
    expect(loadScreenLayout()).toBe("deck");
  });

  it("stored deck runs deck on a phone with Developer mode never set", () => {
    localStorage.removeItem("owncord:settings:developerMode");
    stubPhone(true);
    expect(loadScreenLayout()).toBe("deck");
    expect(loadStoredScreenLayout()).toBe("deck");
  });

  it("no matchMedia counts as not a phone", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(loadScreenLayout()).toBe("deck");
  });
});
