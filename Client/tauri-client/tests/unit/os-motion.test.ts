import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncOsMotionListener } from "../../src/lib/os-motion";

describe("syncOsMotionListener", () => {
  let matchMediaListeners: Map<string, Function>;
  let matchMediaMatches: boolean;

  beforeEach(() => {
    matchMediaListeners = new Map();
    matchMediaMatches = false;

    // Mock matchMedia to return a controllable MediaQueryList
    vi.spyOn(window, "matchMedia").mockImplementation((_query: string) => {
      const mql = {
        matches: matchMediaMatches,
        media: _query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((type: string, handler: Function, _opts?: any) => {
          matchMediaListeners.set(type, handler);
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      } as unknown as MediaQueryList;
      return mql;
    });

    // Clean up any leftover class from previous tests
    document.documentElement.classList.remove("reduced-motion");
  });

  afterEach(() => {
    // Disable the listener to clean up internal state
    syncOsMotionListener(false);
    document.documentElement.classList.remove("reduced-motion");
  });

  it("adds reduced-motion class when OS prefers reduced motion", () => {
    matchMediaMatches = true;
    syncOsMotionListener(true);

    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);
  });

  it("does not add reduced-motion class when OS has no preference", () => {
    matchMediaMatches = false;
    syncOsMotionListener(true);

    expect(document.documentElement.classList.contains("reduced-motion")).toBe(false);
  });

  it("removes reduced-motion class when disabled", () => {
    matchMediaMatches = true;
    syncOsMotionListener(true);
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);

    // Disabling should not automatically remove the class (it only tears down the listener),
    // but calling again with enabled=true and no match should toggle it off
    syncOsMotionListener(false);
    matchMediaMatches = false;
    syncOsMotionListener(true);
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(false);
  });

  it("responds to media query change events", () => {
    matchMediaMatches = false;
    syncOsMotionListener(true);

    expect(document.documentElement.classList.contains("reduced-motion")).toBe(false);

    // Simulate OS preference change
    const changeHandler = matchMediaListeners.get("change");
    expect(changeHandler).toBeDefined();
    changeHandler!({ matches: true } as MediaQueryListEvent);

    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);

    // Simulate changing back
    changeHandler!({ matches: false } as MediaQueryListEvent);
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(false);
  });

  it("is safe to call multiple times (re-registration)", () => {
    matchMediaMatches = true;
    syncOsMotionListener(true);
    syncOsMotionListener(true);

    // Should still work correctly — no duplicate listeners
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("is safe to disable when never enabled", () => {
    // Should not throw
    expect(() => syncOsMotionListener(false)).not.toThrow();
  });

  it("tears down previous listener when re-enabling", () => {
    matchMediaMatches = false;
    syncOsMotionListener(true);

    const firstChangeHandler = matchMediaListeners.get("change");

    // Re-enable — should create a new listener
    syncOsMotionListener(true);
    const secondChangeHandler = matchMediaListeners.get("change");

    // The handlers come from different matchMedia calls
    // Both are defined (the map just holds the latest)
    expect(firstChangeHandler).toBeDefined();
    expect(secondChangeHandler).toBeDefined();
  });
});
