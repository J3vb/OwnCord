import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadPref,
  loadStoredJson,
  readMigratedStringPref,
  readStored,
  removeStored,
  savePref,
  saveStoredJson,
  storedKeys,
  STORAGE_PREFIX,
  writeStored,
} from "../../src/lib/prefs/preferences";
import { expectConsole } from "../helpers/console";

/**
 * Tests for src/lib/prefs/preferences.ts — localStorage preference helpers.
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
      const event = handler.mock.calls[0]![0] as CustomEvent;
      expect(event.detail).toEqual({ key: "fontSize" });

      window.removeEventListener("owncord:pref-change", handler);
    });

    it("does not throw when localStorage.setItem throws (quota exceeded)", () => {
      const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      // Should not throw — silently swallows the error
      expect(() => savePref("big", "data")).not.toThrow();
      expectConsole("warn", /\[preferences\] Failed to save preference/);
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

  // ── guarded raw access ───────────────────────────────────

  describe("guarded raw access", () => {
    it("round-trips raw strings and JSON under full keys", () => {
      expect(writeStored("owncord:raw", "v")).toBe(true);
      expect(readStored("owncord:raw")).toBe("v");
      expect(saveStoredJson("owncord:list", [1, 2])).toBe(true);
      expect(loadStoredJson("owncord:list", (v) => (Array.isArray(v) ? v : []), [])).toEqual([
        1, 2,
      ]);
      expect(storedKeys().sort()).toEqual(["owncord:list", "owncord:raw"]);
      expect(removeStored("owncord:raw")).toBe(true);
      expect(readStored("owncord:raw")).toBeNull();
    });

    it("falls back when the JSON is corrupt or the parser rejects it", () => {
      localStorage.setItem("owncord:bad", "{not json");
      expect(loadStoredJson("owncord:bad", () => "parsed", "fallback")).toBe("fallback");
      localStorage.setItem("owncord:wrong", "42");
      const reject = (): string => {
        throw new Error("wrong shape");
      };
      expect(loadStoredJson("owncord:wrong", reject, "fallback")).toBe("fallback");
    });

    it("never throws when storage is blocked", () => {
      const blocked = (): never => {
        throw new DOMException("storage blocked", "SecurityError");
      };
      const spies = [
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked),
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked),
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked),
      ];
      try {
        expect(readStored("k")).toBeNull();
        expect(writeStored("k", "v")).toBe(false);
        expect(removeStored("k")).toBe(false);
        expect(saveStoredJson("k", [1])).toBe(false);
        expect(loadStoredJson("k", () => "parsed", "fallback")).toBe("fallback");
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});

describe("loadPref with an object fallback", () => {
  beforeEach(() => localStorage.clear());

  it("returns the fallback when the stored value is JSON null", () => {
    localStorage.setItem(STORAGE_PREFIX + "obj", "null");
    const fallback = { a: 1 };
    expect(loadPref("obj", fallback)).toBe(fallback);
  });

  it("returns a stored object", () => {
    localStorage.setItem(STORAGE_PREFIX + "obj", JSON.stringify({ b: 2 }));
    expect(loadPref("obj", { a: 1 })).toEqual({ b: 2 });
  });
});

describe("savePref failure report", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the key that could not be saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    savePref("bigKey", "data");
    expectConsole("warn", /"key":"bigKey"/);
  });
});

describe("readMigratedStringPref", () => {
  const ALLOWED = ["small", "large"] as const;
  beforeEach(() => localStorage.clear());

  it("returns the current value when it is allowed", () => {
    localStorage.setItem(STORAGE_PREFIX + "size", JSON.stringify("large"));
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("large");
  });

  it("ignores a current value that is not allowed", () => {
    localStorage.setItem(STORAGE_PREFIX + "size", JSON.stringify("huge"));
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("small");
  });

  it("ignores a current value that is not a string, and unreadable current text", () => {
    localStorage.setItem(STORAGE_PREFIX + "size", JSON.stringify(3));
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("small");
    localStorage.setItem(STORAGE_PREFIX + "size", "{broken");
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("small");
  });

  it("moves a JSON-encoded legacy value under the prefixed key", () => {
    localStorage.setItem("size", JSON.stringify("large"));
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("large");
    expect(localStorage.getItem(STORAGE_PREFIX + "size")).toBe('"large"');
  });

  it("moves a raw legacy value under the prefixed key", () => {
    localStorage.setItem("size", "large");
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("large");
    expect(localStorage.getItem(STORAGE_PREFIX + "size")).toBe('"large"');
  });

  it("does not move a legacy value that is not allowed", () => {
    localStorage.setItem("size", "huge");
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("small");
    expect(localStorage.getItem(STORAGE_PREFIX + "size")).toBeNull();
    localStorage.setItem("size", JSON.stringify(7));
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("small");
    expect(localStorage.getItem(STORAGE_PREFIX + "size")).toBeNull();
  });

  it("returns the fallback when nothing is stored", () => {
    expect(readMigratedStringPref("size", "small", ALLOWED)).toBe("small");
  });
});

describe("storedKeys with unusable storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists nothing instead of throwing", () => {
    vi.stubGlobal(
      "localStorage",
      new Proxy(
        {},
        {
          ownKeys() {
            throw new DOMException("storage blocked", "SecurityError");
          },
        },
      ),
    );
    expect(storedKeys()).toEqual([]);
  });
});
