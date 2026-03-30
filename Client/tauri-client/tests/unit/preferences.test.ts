import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadPref, savePref, STORAGE_PREFIX } from "../../src/lib/preferences";

/**
 * Tests for src/lib/preferences.ts — localStorage preference helpers.
 * Covers loadPref (cache miss, hit, type mismatch, corrupted JSON, null value),
 * savePref (write, custom event dispatch, quota exceeded), and the STORAGE_PREFIX constant.
 */

describe("preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // ── STORAGE_PREFIX constant ──────────────────────────────

  describe("STORAGE_PREFIX", () => {
    it("equals 'owncord:settings:'", () => {
      expect(STORAGE_PREFIX).toBe("owncord:settings:");
    });
  });

  // ── loadPref ─────────────────────────────────────────────

  describe("loadPref", () => {
    it("returns the fallback when the key does not exist", () => {
      expect(loadPref("nonexistent", 42)).toBe(42);
    });

    it("returns the fallback when the key does not exist (string)", () => {
      expect(loadPref("missing", "default")).toBe("default");
    });

    it("returns the stored value when it exists and matches the fallback type", () => {
      localStorage.setItem(STORAGE_PREFIX + "volume", JSON.stringify(75));
      expect(loadPref("volume", 50)).toBe(75);
    });

    it("returns the stored boolean value", () => {
      localStorage.setItem(STORAGE_PREFIX + "compact", JSON.stringify(true));
      expect(loadPref("compact", false)).toBe(true);
    });

    it("returns the stored string value", () => {
      localStorage.setItem(STORAGE_PREFIX + "theme", JSON.stringify("dark"));
      expect(loadPref("theme", "light")).toBe("dark");
    });

    it("returns the fallback when the stored type differs from the fallback type", () => {
      // Stored a string, but fallback is a number
      localStorage.setItem(STORAGE_PREFIX + "volume", JSON.stringify("not-a-number"));
      expect(loadPref("volume", 50)).toBe(50);
    });

    it("returns the fallback when stored value is null", () => {
      localStorage.setItem(STORAGE_PREFIX + "setting", JSON.stringify(null));
      expect(loadPref("setting", "default")).toBe("default");
    });

    it("returns the fallback when stored JSON is corrupted (invalid JSON)", () => {
      localStorage.setItem(STORAGE_PREFIX + "broken", "{invalid json");
      expect(loadPref("broken", 100)).toBe(100);
    });

    it("returns the fallback when stored value is a boolean but fallback is a number", () => {
      localStorage.setItem(STORAGE_PREFIX + "mixup", JSON.stringify(true));
      expect(loadPref("mixup", 0)).toBe(0);
    });

    it("returns the fallback when stored value is a number but fallback is a string", () => {
      localStorage.setItem(STORAGE_PREFIX + "mixup2", JSON.stringify(42));
      expect(loadPref("mixup2", "hello")).toBe("hello");
    });

    it("returns the fallback when localStorage.getItem throws", () => {
      const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Storage disabled");
      });

      expect(loadPref("any", "safe")).toBe("safe");
      spy.mockRestore();
    });
  });

  // ── savePref ─────────────────────────────────────────────

  describe("savePref", () => {
    it("writes a value to localStorage with the correct prefix", () => {
      savePref("volume", 80);
      const raw = localStorage.getItem(STORAGE_PREFIX + "volume");
      expect(raw).toBe("80");
    });

    it("writes a string value to localStorage", () => {
      savePref("theme", "neon-glow");
      const raw = localStorage.getItem(STORAGE_PREFIX + "theme");
      expect(raw).toBe('"neon-glow"');
    });

    it("writes a boolean value to localStorage", () => {
      savePref("compact", true);
      const raw = localStorage.getItem(STORAGE_PREFIX + "compact");
      expect(raw).toBe("true");
    });

    it("overwrites an existing value", () => {
      savePref("volume", 50);
      savePref("volume", 75);
      const raw = localStorage.getItem(STORAGE_PREFIX + "volume");
      expect(raw).toBe("75");
    });

    it("dispatches an 'owncord:pref-change' CustomEvent with the key in detail", () => {
      const handler = vi.fn();
      window.addEventListener("owncord:pref-change", handler);

      savePref("fontSize", 16);

      expect(handler).toHaveBeenCalledOnce();
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toEqual({ key: "fontSize" });

      window.removeEventListener("owncord:pref-change", handler);
    });

    it("does not throw when localStorage.setItem throws (quota exceeded)", () => {
      const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      // Should not throw — silently swallows the error
      expect(() => savePref("big", "data")).not.toThrow();
      spy.mockRestore();
    });

    it("stores null values as JSON", () => {
      savePref("nullable", null);
      const raw = localStorage.getItem(STORAGE_PREFIX + "nullable");
      expect(raw).toBe("null");
    });

    it("stores object values as JSON", () => {
      savePref("obj", { a: 1, b: "two" });
      const raw = localStorage.getItem(STORAGE_PREFIX + "obj");
      expect(raw).toBe('{"a":1,"b":"two"}');
    });
  });

  // ── round-trip ───────────────────────────────────────────

  describe("round-trip (savePref → loadPref)", () => {
    it("round-trips a number", () => {
      savePref("num", 42);
      expect(loadPref("num", 0)).toBe(42);
    });

    it("round-trips a string", () => {
      savePref("str", "hello");
      expect(loadPref("str", "")).toBe("hello");
    });

    it("round-trips a boolean", () => {
      savePref("bool", false);
      expect(loadPref("bool", true)).toBe(false);
    });
  });
});
