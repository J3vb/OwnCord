import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadPref,
  savePref,
  applyTheme,
  STORAGE_PREFIX,
  THEMES,
} from "../../src/components/settings/helpers";
import type { ThemeName } from "../../src/components/settings/helpers";

describe("settings/helpers", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    localStorage.clear();
  });

  describe("STORAGE_PREFIX", () => {
    it("has the correct prefix value", () => {
      expect(STORAGE_PREFIX).toBe("owncord:settings:");
    });
  });

  describe("loadPref", () => {
    it("returns fallback when key does not exist", () => {
      const result = loadPref("nonexistent", "default");
      expect(result).toBe("default");
    });

    it("returns stored value when key exists", () => {
      localStorage.setItem(STORAGE_PREFIX + "theme", JSON.stringify("midnight"));
      const result = loadPref("theme", "dark");
      expect(result).toBe("midnight");
    });

    it("returns fallback on invalid JSON", () => {
      localStorage.setItem(STORAGE_PREFIX + "broken", "not-valid-json");
      const result = loadPref("broken", "fallback");
      expect(result).toBe("fallback");
    });

    it("handles boolean values", () => {
      localStorage.setItem(STORAGE_PREFIX + "notifications", JSON.stringify(true));
      expect(loadPref("notifications", false)).toBe(true);
    });

    it("handles numeric values", () => {
      localStorage.setItem(STORAGE_PREFIX + "volume", JSON.stringify(75));
      expect(loadPref("volume", 50)).toBe(75);
    });

    it("handles object values", () => {
      const obj = { fontSize: 14, compact: true };
      localStorage.setItem(STORAGE_PREFIX + "display", JSON.stringify(obj));
      const result = loadPref("display", {});
      expect(result).toEqual(obj);
    });
  });

  describe("savePref", () => {
    it("stores value with correct prefix", () => {
      savePref("theme", "midnight");
      const raw = localStorage.getItem(STORAGE_PREFIX + "theme");
      expect(raw).toBe(JSON.stringify("midnight"));
    });

    it("stores boolean values", () => {
      savePref("notifications", true);
      const raw = localStorage.getItem(STORAGE_PREFIX + "notifications");
      expect(raw).toBe("true");
    });

    it("stores numeric values", () => {
      savePref("volume", 80);
      const raw = localStorage.getItem(STORAGE_PREFIX + "volume");
      expect(raw).toBe("80");
    });

    it("stores object values", () => {
      const obj = { a: 1, b: "two" };
      savePref("config", obj);
      const raw = localStorage.getItem(STORAGE_PREFIX + "config");
      expect(JSON.parse(raw!)).toEqual(obj);
    });

    it("overwrites existing values", () => {
      savePref("theme", "dark");
      savePref("theme", "light");
      expect(loadPref("theme", "dark")).toBe("light");
    });
  });

  describe("applyTheme", () => {
    it("sets CSS custom properties for dark theme", () => {
      applyTheme("dark");
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--bg-primary")).toBe("#313338");
      expect(root.style.getPropertyValue("--bg-secondary")).toBe("#2b2d31");
      expect(root.style.getPropertyValue("--bg-tertiary")).toBe("#1e1f22");
      expect(root.style.getPropertyValue("--text-normal")).toBe("#dbdee1");
    });

    it("sets CSS custom properties for midnight theme", () => {
      applyTheme("midnight");
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--bg-primary")).toBe("#1a1a2e");
    });

    it("sets CSS custom properties for light theme", () => {
      applyTheme("light");
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--bg-primary")).toBe("#ffffff");
      expect(root.style.getPropertyValue("--text-normal")).toBe("#313338");
    });

    it("overwrites previous theme variables", () => {
      applyTheme("dark");
      applyTheme("light");
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--bg-primary")).toBe("#ffffff");
    });
  });

  describe("THEMES", () => {
    it("contains dark, midnight, and light themes", () => {
      const themeNames = Object.keys(THEMES);
      expect(themeNames).toContain("dark");
      expect(themeNames).toContain("midnight");
      expect(themeNames).toContain("light");
    });

    it("each theme has required CSS variables", () => {
      for (const [, vars] of Object.entries(THEMES)) {
        expect(vars).toHaveProperty("--bg-primary");
        expect(vars).toHaveProperty("--bg-secondary");
        expect(vars).toHaveProperty("--bg-tertiary");
        expect(vars).toHaveProperty("--text-normal");
      }
    });
  });
});
