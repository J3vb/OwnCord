import { describe, it, expect, beforeEach } from "vitest";
import { applyThemeByName, getActiveThemeName, restoreTheme } from "@lib/themes";

describe("themes", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
  });

  it("applies neon-glow theme class to body", () => {
    applyThemeByName("neon-glow");
    expect(document.body.classList.contains("theme-neon-glow")).toBe(true);
  });

  it("removes previous theme class when switching", () => {
    applyThemeByName("neon-glow");
    applyThemeByName("dark");
    expect(document.body.classList.contains("theme-neon-glow")).toBe(false);
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });

  it("persists active theme name", () => {
    applyThemeByName("neon-glow");
    expect(getActiveThemeName()).toBe("neon-glow");
  });

  it("migrates the legacy settings theme key to the active theme key", () => {
    localStorage.setItem("owncord:settings:theme", JSON.stringify("midnight"));

    expect(getActiveThemeName()).toBe("midnight");
    expect(localStorage.getItem("owncord:theme:active")).toBe("midnight");
  });

  it("ignores an invalid active theme when a valid legacy theme exists", () => {
    localStorage.setItem("owncord:theme:active", "stale-theme");
    localStorage.setItem("owncord:settings:theme", JSON.stringify("midnight"));

    expect(getActiveThemeName()).toBe("midnight");
    expect(localStorage.getItem("owncord:theme:active")).toBe("midnight");
  });
});

describe("restoreTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    for (let i = document.body.style.length - 1; i >= 0; i--) {
      document.body.style.removeProperty(document.body.style.item(i));
    }
    for (let i = document.documentElement.style.length - 1; i >= 0; i--) {
      document.documentElement.style.removeProperty(document.documentElement.style.item(i));
    }
  });

  it("should apply saved theme name from localStorage", () => {
    localStorage.setItem("owncord:theme:active", "midnight");
    restoreTheme();
    expect(document.body.classList.contains("theme-midnight")).toBe(true);
  });

  it("should apply saved accent color on document", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("#00ff00"));
    restoreTheme();
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#00ff00");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#00ff00");
  });

  it("should reject accent color that is not valid hex", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("url(evil)"));
    restoreTheme();
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("should handle corrupted localStorage gracefully", () => {
    localStorage.setItem("owncord:settings:accentColor", "NOT VALID JSON {{{");
    // Should not throw
    expect(() => restoreTheme()).not.toThrow();
    // No accent should be set
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("should default to neon-glow when no saved theme", () => {
    restoreTheme();
    expect(document.body.classList.contains("theme-neon-glow")).toBe(true);
  });
});
