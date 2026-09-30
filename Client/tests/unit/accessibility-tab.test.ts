import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAccessibilityTab } from "@components/settings/AccessibilityTab";

// ---------------------------------------------------------------------------
// Mock os-motion module
// ---------------------------------------------------------------------------

const { mockSyncOsMotionListener } = vi.hoisted(() => ({
  mockSyncOsMotionListener: vi.fn(),
}));

vi.mock("@lib/os-motion", () => ({
  SYNC_OS_MOTION_DEFAULT: true,
  syncOsMotionListener: mockSyncOsMotionListener,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The tests name toggles by their original index; the tab groups them now. */
const TOGGLE_LABELS = [
  "Reduce Motion",
  "High Contrast",
  "Role Colors",
  "Sync with OS",
  "Large Font",
] as const;

/** Return the toggle named by the label at `index` in TOGGLE_LABELS. */
function getToggle(container: HTMLElement, index: number): HTMLElement {
  return container.querySelector(`.toggle[aria-label="${TOGGLE_LABELS[index]}"]`) as HTMLElement;
}

/** Click that toggle. */
function clickToggle(container: HTMLElement, index: number): HTMLElement {
  const toggle = getToggle(container, index);
  toggle.click();
  return toggle;
}

/** The rows that hold a switch (the text-size readout has none). */
const toggleRows = (container: HTMLElement) =>
  container.querySelectorAll(".setting-row:not(.setting-readout)");

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

      const labelTexts = Array.from(toggleRows(container)).map(
        (r) => r.querySelector(".setting-label")!.textContent,
      );

      // Grouped: Motion, Readability, Chat.
      expect(labelTexts).toEqual([
        "Reduce Motion",
        "Sync with OS",
        "High Contrast",
        "Large Font",
        "Role Colors",
      ]);
    });

    it("renders descriptions for all toggles", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const desc = (label: string) =>
        Array.from(toggleRows(container))
          .find((r) => r.querySelector(".setting-label")!.textContent === label)!
          .querySelector(".setting-desc")!.textContent;

      expect(desc("Reduce Motion")).toBe("Disable animations and transitions");
      expect(desc("High Contrast")).toBe("Increase contrast for better readability");
      expect(desc("Role Colors")).toBe("Show colored usernames based on role in chat");
      // The OS row says what the system is asking for right now.
      expect(desc("Sync with OS")).toBe(
        "Follow your system setting. It is not asking for less motion right now.",
      );
      expect(desc("Large Font")).toBe("Use larger text throughout the app for better readability");
    });

    it("renders each row with setting-row class", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const rows = toggleRows(container);
      expect(rows.length).toBe(5);
    });

    it("groups the toggles under Motion, Readability and Chat headings", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const titles = Array.from(container.querySelectorAll("h3.setting-group-title")).map(
        (h) => h.textContent,
      );
      expect(titles).toEqual(["Motion", "Readability", "Chat"]);
      const groupOf = (label: string) => {
        const row = container
          .querySelector(`.toggle[aria-label="${label}"]`)!
          .closest(".setting-group")!;
        return row.querySelector("h3")!.textContent;
      };
      expect(groupOf("Reduce Motion")).toBe("Motion");
      expect(groupOf("Sync with OS")).toBe("Motion");
      expect(groupOf("High Contrast")).toBe("Readability");
      expect(groupOf("Large Font")).toBe("Readability");
      expect(groupOf("Role Colors")).toBe("Chat");
    });

    it("nests the OS setting under Reduce Motion, which it only affects", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const row = getToggle(container, 3).closest(".setting-row")!;
      expect(row.classList.contains("nested")).toBe(true);
      expect(row.previousElementSibling!.querySelector(".setting-label")!.textContent).toBe(
        "Reduce Motion",
      );
    });

    it("says when the system is asking for less motion", () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }),
      );
      try {
        const section = buildAccessibilityTab(ac.signal);
        container.appendChild(section);
        const row = getToggle(container, 3).closest(".setting-row")!;
        expect(row.querySelector(".setting-desc")!.textContent).toBe(
          "Follow your system setting. It is asking for less motion right now.",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("shows the effective text size, set in Appearance, and follows Large Font", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const readout = container.querySelector<HTMLElement>(".setting-readout")!;
      expect(readout.querySelector(".setting-label")!.textContent).toBe("Text size");
      expect(readout.querySelector(".setting-desc")!.textContent).toBe("Set in Appearance");
      expect(readout.querySelector(".setting-value")!.textContent).toBe("16px");
      clickToggle(container, 4);
      expect(readout.querySelector(".setting-value")!.textContent).toBe("18px");
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

    it("syncOsMotion defaults to on, so the OS setting is honoured (B9-2, Q1)", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      expect(getToggle(container, 3).classList.contains("on")).toBe(true);
    });

    it("restores syncOsMotion off from localStorage", () => {
      localStorage.setItem("owncord:settings:syncOsMotion", "false");

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
      localStorage.setItem("owncord:settings:syncOsMotion", "false");
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
    it("routes reducedMotion through syncOsMotionListener rather than writing the class directly (OC-0232)", () => {
      // os-motion.ts is the single writer of `.reduced-motion`; the Reduce
      // Motion toggle must delegate to it (passing the current syncOsMotion
      // pref) instead of touching documentElement itself, so a manual toggle
      // can no longer fight the OS-sync listener. With os-motion mocked here,
      // the real class-application behaviour is covered in AccessibilityTab.test.ts.
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      // No stored syncOsMotion, so the default (on) is what gets passed.
      clickToggle(container, 0);
      expect(mockSyncOsMotionListener).toHaveBeenLastCalledWith(true);

      clickToggle(container, 0);
      expect(mockSyncOsMotionListener).toHaveBeenLastCalledWith(true);
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
      localStorage.setItem("owncord:settings:syncOsMotion", "false");
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

    it("each toggle is named by the visible label beside it (B9-2)", () => {
      const section = buildAccessibilityTab(ac.signal);
      container.appendChild(section);

      const rows = toggleRows(container);
      expect(rows.length).toBe(5);
      for (const row of rows) {
        const label = row.querySelector(".setting-label")?.textContent;
        expect(label).toBeTruthy();
        expect(row.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe(label);
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
