import { describe, it, expect, beforeEach } from "vitest";
import {
  applyThemeByName,
  getActiveThemeName,
  listThemeNames,
  saveCustomTheme,
  loadCustomTheme,
  deleteCustomTheme,
  exportTheme,
  restoreTheme,
  type OwnCordTheme,
} from "@lib/themes";

describe("themes", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
  });

  it("lists built-in theme names", () => {
    const names = listThemeNames();
    expect(names).toContain("dark");
    expect(names).toContain("neon-glow");
    expect(names).toContain("midnight");
    expect(names).toContain("light");
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

  it("saves and loads a custom theme", () => {
    const custom: OwnCordTheme = {
      name: "my-red",
      author: "TestUser",
      version: "1.0.0",
      colors: { "--accent-primary": "#ff0000" },
    };
    saveCustomTheme(custom);
    const loaded = loadCustomTheme("my-red");
    expect(loaded).toEqual(custom);
  });

  it("deletes a custom theme", () => {
    const custom: OwnCordTheme = {
      name: "temp",
      author: "",
      version: "1.0.0",
      colors: {},
    };
    saveCustomTheme(custom);
    deleteCustomTheme("temp");
    expect(loadCustomTheme("temp")).toBeNull();
  });

  it("exports a theme as JSON", () => {
    const custom: OwnCordTheme = {
      name: "export-test",
      author: "User",
      version: "1.0.0",
      colors: { "--accent-primary": "#00ff00" },
    };
    const json = exportTheme(custom);
    const parsed = JSON.parse(json) as OwnCordTheme;
    expect(parsed.name).toBe("export-test");
  });

  it("persists active theme name", () => {
    applyThemeByName("neon-glow");
    expect(getActiveThemeName()).toBe("neon-glow");
  });
});

describe("CSS injection prevention", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    // Clear any inline styles from previous tests
    for (let i = document.body.style.length - 1; i >= 0; i--) {
      const prop = document.body.style.item(i);
      document.body.style.removeProperty(prop);
    }
  });

  function applyCustomWithColors(colors: Record<string, string>): void {
    const theme: OwnCordTheme = {
      name: "injection-test",
      author: "attacker",
      version: "1.0.0",
      colors,
    };
    saveCustomTheme(theme);
    applyThemeByName("injection-test");
  }

  it("should reject custom theme value containing url()", () => {
    applyCustomWithColors({ "--bg": "url(https://evil.com/steal)" });
    expect(document.body.style.getPropertyValue("--bg")).toBe("");
  });

  it("should reject custom theme value containing expression()", () => {
    applyCustomWithColors({ "--bg": "expression(alert(1))" });
    expect(document.body.style.getPropertyValue("--bg")).toBe("");
  });

  it("should reject custom theme value containing semicolons", () => {
    applyCustomWithColors({ "--bg": "#ff0000; background: red" });
    expect(document.body.style.getPropertyValue("--bg")).toBe("");
  });

  it("should reject custom theme value containing braces {}", () => {
    applyCustomWithColors({ "--bg": "red} body { background: red" });
    expect(document.body.style.getPropertyValue("--bg")).toBe("");
  });

  it("should reject custom theme value containing !important", () => {
    applyCustomWithColors({ "--bg": "#ff0000 !important" });
    expect(document.body.style.getPropertyValue("--bg")).toBe("");
  });

  it("should reject property name not starting with --", () => {
    applyCustomWithColors({ "background": "#ff0000" });
    // "background" does not start with "--", so it must not be set
    expect(document.body.style.getPropertyValue("background")).toBe("");
  });

  it("should accept valid hex color values like #ff0000", () => {
    applyCustomWithColors({ "--accent": "#ff0000" });
    expect(document.body.style.getPropertyValue("--accent")).toBe("#ff0000");
  });

  it("should reject rgb()/rgba() values (parentheses blocked to prevent CSS injection)", () => {
    applyCustomWithColors({ "--accent": "rgb(255, 0, 0)" });
    expect(document.body.style.getPropertyValue("--accent")).toBe("");

    applyCustomWithColors({ "--accent": "rgba(255, 0, 0, 0.5)" });
    expect(document.body.style.getPropertyValue("--accent")).toBe("");
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

describe("deleteCustomTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
  });

  it("should fall back to dark theme when deleting active custom theme", () => {
    const custom: OwnCordTheme = {
      name: "doomed",
      author: "",
      version: "1.0.0",
      colors: { "--accent": "#ff0000" },
    };
    saveCustomTheme(custom);
    applyThemeByName("doomed");
    expect(getActiveThemeName()).toBe("doomed");

    deleteCustomTheme("doomed");
    expect(getActiveThemeName()).toBe("dark");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });
});

describe("loadCustomTheme validation", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should return null for invalid JSON", () => {
    localStorage.setItem("owncord:theme:custom:broken", "NOT JSON {{{");
    expect(loadCustomTheme("broken")).toBeNull();
  });

  it("should return null for object missing name", () => {
    localStorage.setItem(
      "owncord:theme:custom:noname",
      JSON.stringify({ colors: { "--a": "#000" } }),
    );
    expect(loadCustomTheme("noname")).toBeNull();
  });

  it("should return null for object missing colors", () => {
    localStorage.setItem(
      "owncord:theme:custom:nocolors",
      JSON.stringify({ name: "nocolors", author: "x", version: "1" }),
    );
    expect(loadCustomTheme("nocolors")).toBeNull();
  });
});
