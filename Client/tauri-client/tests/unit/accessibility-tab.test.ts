import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAccessibilityTab } from "@components/settings/AccessibilityTab";

// ---------------------------------------------------------------------------
// Mock os-motion module
// ---------------------------------------------------------------------------

const { mockSyncOsMotionListener } = vi.hoisted(() => ({
  mockSyncOsMotionListener: vi.fn(),
}));

vi.mock("@lib/os-motion", () => ({
  syncOsMotionListener: mockSyncOsMotionListener,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Click a toggle by its 0-based index in the rendered section. */
function clickToggle(container: HTMLElement, index: number): HTMLElement {
  const toggles = container.querySelectorAll(".toggle");
  const toggle = toggles[index] as HTMLElement;
  toggle.click();
  return toggle;
}

/** Return the toggle element at a given index. */
function getToggle(container: HTMLElement, index: number): HTMLElement {
  return container.querySelectorAll(".toggle")[index] as HTMLElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AccessibilityTab", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    document.documentElement.className = "";
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
    document.documentElement.className = "";
  });

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  describe("rendering", () => {
    it("renders a settings-pane with active class", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(section.classList.contains("settings-pane")).toBe(true);
      expect(section.classList.contains("active")).toBe(true);
    });

    it("renders exactly 5 toggles", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggles = container.querySelectorAll(".toggle");
      expect(toggles.length).toBe(5);
    });

    it("renders all 5 setting labels", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const labels = container.querySelectorAll(".setting-label");
      const labelTexts = Array.from(labels).map((l) => l.textContent);

      expect(labelTexts).toEqual([
        "Reduce Motion",
        "High Contrast",
        "Role Colors",
        "Sync with OS",
        "Large Font",
      ]);
    });

    it("renders descriptions for all toggles", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const descs = container.querySelectorAll(".setting-desc");
      expect(descs.length).toBe(5);

      expect(descs[0]?.textContent).toBe("Disable animations and transitions");
      expect(descs[1]?.textContent).toBe("Increase contrast for better readability");
      expect(descs[2]?.textContent).toBe("Show colored usernames based on role in chat");
      expect(descs[3]?.textContent).toBe(
        "Automatically enable reduced motion based on your OS accessibility settings",
      );
      expect(descs[4]?.textContent).toBe(
        "Use larger text throughout the app for better readability",
      );
    });

    it("renders each row with setting-row class", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const rows = container.querySelectorAll(".setting-row");
      expect(rows.length).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Default states
  // -----------------------------------------------------------------------

  describe("default states", () => {
    it("reducedMotion defaults to off", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 0).classList.contains("on")).toBe(false);
    });

    it("highContrast defaults to off", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 1).classList.contains("on")).toBe(false);
    });

    it("roleColors defaults to on", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 2).classList.contains("on")).toBe(true);
    });

    it("syncOsMotion defaults to off", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 3).classList.contains("on")).toBe(false);
    });

    it("largeFont defaults to off", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 4).classList.contains("on")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Restoring from localStorage
  // -----------------------------------------------------------------------

  describe("restore from localStorage", () => {
    it("restores reducedMotion on from localStorage", () => {
      localStorage.setItem("owncord:settings:reducedMotion", "true");

      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 0).classList.contains("on")).toBe(true);
    });

    it("restores highContrast on from localStorage", () => {
      localStorage.setItem("owncord:settings:highContrast", "true");

      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 1).classList.contains("on")).toBe(true);
    });

    it("restores roleColors off from localStorage", () => {
      localStorage.setItem("owncord:settings:roleColors", "false");

      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 2).classList.contains("on")).toBe(false);
    });

    it("restores syncOsMotion on from localStorage", () => {
      localStorage.setItem("owncord:settings:syncOsMotion", "true");

      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 3).classList.contains("on")).toBe(true);
    });

    it("restores largeFont on from localStorage", () => {
      localStorage.setItem("owncord:settings:largeFont", "true");

      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 4).classList.contains("on")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Toggle click behavior — persistence
  // -----------------------------------------------------------------------

  describe("toggle persistence", () => {
    it("persists reducedMotion to localStorage on toggle", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 0);
      expect(localStorage.getItem("owncord:settings:reducedMotion")).toBe("true");

      clickToggle(container, 0);
      expect(localStorage.getItem("owncord:settings:reducedMotion")).toBe("false");
    });

    it("persists highContrast to localStorage on toggle", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 1);
      expect(localStorage.getItem("owncord:settings:highContrast")).toBe("true");
    });

    it("persists roleColors to localStorage on toggle", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      // roleColors defaults to on, so first click turns it off
      clickToggle(container, 2);
      expect(localStorage.getItem("owncord:settings:roleColors")).toBe("false");
    });

    it("persists syncOsMotion to localStorage on toggle", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 3);
      expect(localStorage.getItem("owncord:settings:syncOsMotion")).toBe("true");
    });

    it("persists largeFont to localStorage on toggle", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 4);
      expect(localStorage.getItem("owncord:settings:largeFont")).toBe("true");
    });
  });

  // -----------------------------------------------------------------------
  // Side effects
  // -----------------------------------------------------------------------

  describe("side effects", () => {
    it("toggles reduced-motion class on documentElement for reducedMotion", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 0);
      expect(document.documentElement.classList.contains("reduced-motion")).toBe(true);

      clickToggle(container, 0);
      expect(document.documentElement.classList.contains("reduced-motion")).toBe(false);
    });

    it("toggles high-contrast class on documentElement for highContrast", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 1);
      expect(document.documentElement.classList.contains("high-contrast")).toBe(true);

      clickToggle(container, 1);
      expect(document.documentElement.classList.contains("high-contrast")).toBe(false);
    });

    it("does NOT have a side effect for roleColors (no class toggle)", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      // roleColors starts on, clicking turns it off
      clickToggle(container, 2);

      // No document class should be toggled
      expect(document.documentElement.classList.contains("role-colors")).toBe(false);
    });

    it("calls syncOsMotionListener(true) when syncOsMotion is toggled on", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 3);
      expect(mockSyncOsMotionListener).toHaveBeenCalledWith(true);
    });

    it("calls syncOsMotionListener(false) when syncOsMotion is toggled off", () => {
      localStorage.setItem("owncord:settings:syncOsMotion", "true");

      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 3);
      expect(mockSyncOsMotionListener).toHaveBeenCalledWith(false);
    });

    it("toggles large-font class on documentElement for largeFont", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      clickToggle(container, 4);
      expect(document.documentElement.classList.contains("large-font")).toBe(true);

      clickToggle(container, 4);
      expect(document.documentElement.classList.contains("large-font")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // ARIA attributes
  // -----------------------------------------------------------------------

  describe("ARIA accessibility", () => {
    it("toggles have role=switch", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggles = container.querySelectorAll(".toggle");
      for (const toggle of toggles) {
        expect(toggle.getAttribute("role")).toBe("switch");
      }
    });

    it("toggles have aria-checked matching their state", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      // reducedMotion off
      expect(getToggle(container, 0).getAttribute("aria-checked")).toBe("false");
      // roleColors on
      expect(getToggle(container, 2).getAttribute("aria-checked")).toBe("true");
    });

    it("aria-checked updates when toggle is clicked", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggle = clickToggle(container, 0);
      expect(toggle.getAttribute("aria-checked")).toBe("true");

      clickToggle(container, 0);
      expect(getToggle(container, 0).getAttribute("aria-checked")).toBe("false");
    });

    it("toggles have tabindex=0 for keyboard focus", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggles = container.querySelectorAll(".toggle");
      for (const toggle of toggles) {
        expect(toggle.getAttribute("tabindex")).toBe("0");
      }
    });

    it("toggles respond to Enter key", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggle = getToggle(container, 0);
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(toggle.classList.contains("on")).toBe(true);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    it("toggles respond to Space key", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggle = getToggle(container, 1);
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

      expect(toggle.classList.contains("on")).toBe(true);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    it("toggles do NOT respond to other keys", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const toggle = getToggle(container, 0);
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

      expect(toggle.classList.contains("on")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // owncord:pref-change event
  // -----------------------------------------------------------------------

  describe("pref-change custom event", () => {
    it("dispatches owncord:pref-change event on toggle", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const listener = vi.fn();
      window.addEventListener("owncord:pref-change", listener);

      clickToggle(container, 0);

      expect(listener).toHaveBeenCalledTimes(1);
      const detail = (listener.mock.calls[0]![0] as CustomEvent).detail;
      expect(detail).toEqual({ key: "reducedMotion" });

      window.removeEventListener("owncord:pref-change", listener);
    });
  });
});
