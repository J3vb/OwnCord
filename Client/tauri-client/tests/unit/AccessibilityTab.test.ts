import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAccessibilityTab } from "../../src/components/settings/AccessibilityTab";

/**
 * OC-0232: "Reduce Motion" and "Sync with OS" are two independent writers of
 * the `.reduced-motion` class with no arbitration. A manual toggle click
 * writes the class directly, ignoring whether OS sync currently owns it —
 * so turning "Reduce Motion" OFF while "Sync with OS" is ON and the OS still
 * asks for reduced motion silently disables reduced motion app-wide.
 */
describe("AccessibilityTab — reduced-motion arbitration (OC-0232)", () => {
  let container: HTMLDivElement;
  let controller: AbortController;
  let matchMediaListeners: Map<string, Function>;
  const matchMediaMatches = true; // OS prefers reduced motion, for the whole test

  function findToggle(label: string): HTMLElement {
    const rows = container.querySelectorAll(".setting-row");
    for (const row of Array.from(rows)) {
      const labelEl = row.querySelector(".setting-label");
      if (labelEl?.textContent === label) {
        const toggle = row.querySelector('[role="switch"]');
        if (toggle === null) {
          throw new Error(`toggle not found for label "${label}"`);
        }
        return toggle as HTMLElement;
      }
    }
    throw new Error(`row not found for label "${label}"`);
  }

  beforeEach(() => {
    matchMediaListeners = new Map();

    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      const mql = {
        matches: matchMediaMatches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((type: string, handler: Function) => {
          matchMediaListeners.set(type, handler);
        }),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      } as unknown as MediaQueryList;
      return mql;
    });

    localStorage.clear();
    document.documentElement.classList.remove("reduced-motion");

    controller = new AbortController();
    container = buildAccessibilityTab(controller.signal);
    document.body.appendChild(container);
  });

  afterEach(() => {
    controller.abort();
    container.remove();
    document.documentElement.classList.remove("reduced-motion");
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps reduced-motion applied when OS sync is on and the OS still prefers it, even after a manual Reduce Motion toggle is switched off", () => {
    const syncToggle = findToggle("Sync with OS");
    const motionToggle = findToggle("Reduce Motion");

    // Turn on "Sync with OS": the OS prefers reduced motion, so the class
    // should be applied by the media-query-driven listener.
    syncToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);

    // Manually flip "Reduce Motion" on, then off. "Sync with OS" is still
    // on and the (mocked) OS still prefers reduced motion throughout, so
    // the effective state must never change out from under it.
    motionToggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); // -> on
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);

    motionToggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); // -> off
    expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);
  });
});
