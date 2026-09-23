import { describe, it, expect, beforeEach } from "vitest";
import { applyAccent, applyThemeByName, getActiveThemeName, restoreTheme } from "@lib/themes";

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

describe("applyAccent (B9-2, owner decision Q8)", () => {
  const html = document.documentElement.style;
  const body = document.body.style;

  function clearInline(): void {
    for (const style of [html, body]) {
      for (let i = style.length - 1; i >= 0; i--) style.removeProperty(style.item(i));
    }
  }

  /** The dark theme's surfaces, as inline tokens the contrast check reads back. */
  function setDarkSurfaces(): void {
    body.setProperty("--bg-primary", "#313338");
    body.setProperty("--bg-secondary", "#2b2d31");
    body.setProperty("--bg-tertiary", "#1e1f22");
    body.setProperty("--bg-input", "#383a40");
  }

  beforeEach(clearInline);

  it("honours a readable accent for fills, text and focus, and derives the rest", () => {
    setDarkSurfaces();
    applyAccent("#3ba55d");
    for (const style of [html, body]) {
      expect(style.getPropertyValue("--accent")).toBe("#3ba55d");
      expect(style.getPropertyValue("--on-accent")).toBe("#000000");
      expect(style.getPropertyValue("--accent-hover")).toBe("#58b375");
      expect(style.getPropertyValue("--accent-active")).toBe("#76c08e");
    }
    // 3.64:1 at worst: a focus ring (>= 3:1) but not text (< 4.5:1).
    expect(body.getPropertyValue("--accent-text")).toBe("");
    expect(body.getPropertyValue("--focus-ring")).toBe("#3ba55d");

    applyAccent("#57f287"); // 7.3:1 at worst: both uses
    expect(body.getPropertyValue("--accent-text")).toBe("#57f287");
    expect(body.getPropertyValue("--focus-ring")).toBe("#57f287");
  });

  it("keeps the theme's text and focus colours when the accent reads below 3:1", () => {
    setDarkSurfaces();
    // A tested theme value on documentElement (the light theme writes one there).
    html.setProperty("--accent-text", "#4752c4");
    applyAccent("#57f287");
    applyAccent("#5865f2"); // 2.74:1 on #313338
    expect(body.getPropertyValue("--accent")).toBe("#5865f2");
    expect(body.getPropertyValue("--accent-text")).toBe("");
    expect(body.getPropertyValue("--focus-ring")).toBe("");
    expect(html.getPropertyValue("--accent-text")).toBe("#4752c4");
  });

  it("falls back for text and focus when the surfaces cannot be read", () => {
    applyAccent("#ffffff");
    expect(body.getPropertyValue("--accent")).toBe("#ffffff");
    expect(body.getPropertyValue("--accent-text")).toBe("");
  });

  it("applies nothing for a value that is not a colour", () => {
    applyAccent("url(evil)");
    expect(html.length).toBe(0);
    expect(body.length).toBe(0);
  });
});
