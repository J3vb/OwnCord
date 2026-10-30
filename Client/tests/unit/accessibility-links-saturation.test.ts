import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAccessibilityTab } from "@components/settings/AccessibilityTab";
import {
  applySaturation,
  applyStoredAppearance,
  effectiveSaturation,
  DEFAULT_SATURATION_PCT,
} from "@lib/prefs/appearance";
import { syncOsMotionListener } from "@lib/os-motion";

const PREFIX = "owncord:settings:";
const root = document.documentElement;

function slider(section: HTMLElement): HTMLInputElement {
  return section.querySelector<HTMLInputElement>('input[aria-label="Saturation"]')!;
}

function drag(el: HTMLInputElement, value: number): void {
  el.value = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Always underline links and Saturation", () => {
  let owner: AbortController;

  beforeEach(() => {
    localStorage.clear();
    root.className = "";
    root.removeAttribute("style");
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    owner = new AbortController();
  });

  afterEach(() => {
    owner.abort();
    syncOsMotionListener(false);
    vi.unstubAllGlobals();
    root.className = "";
    root.removeAttribute("style");
  });

  describe("Always underline links", () => {
    it("is one switch row, off by default", () => {
      const section = buildAccessibilityTab(owner.signal);
      const toggle = section.querySelector<HTMLElement>(
        '.toggle[aria-label="Always underline links"]',
      )!;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(root.classList.contains("underline-links")).toBe(false);
    });

    it("writes the pref and the class on change, both ways", () => {
      const section = buildAccessibilityTab(owner.signal);
      const toggle = section.querySelector<HTMLElement>(
        '.toggle[aria-label="Always underline links"]',
      )!;
      toggle.click();
      expect(localStorage.getItem(`${PREFIX}underlineLinks`)).toBe("true");
      expect(root.classList.contains("underline-links")).toBe(true);
      toggle.click();
      expect(localStorage.getItem(`${PREFIX}underlineLinks`)).toBe("false");
      expect(root.classList.contains("underline-links")).toBe(false);
    });

    it("is applied at startup from the stored pref", () => {
      localStorage.setItem(`${PREFIX}underlineLinks`, "true");
      applyStoredAppearance();
      expect(root.classList.contains("underline-links")).toBe(true);
    });

    it("ignores a stored value of the wrong type", () => {
      localStorage.setItem(`${PREFIX}underlineLinks`, '"yes"');
      applyStoredAppearance();
      expect(root.classList.contains("underline-links")).toBe(false);
    });
  });

  describe("Saturation", () => {
    it("shows the default 100 % and adds no filter marker", () => {
      const section = buildAccessibilityTab(owner.signal);
      expect(slider(section).value).toBe("100");
      expect(section.textContent).toContain("100%");
      applyStoredAppearance();
      expect(root.style.getPropertyValue("--ui-saturation")).toBe("1");
      expect(root.classList.contains("custom-saturation")).toBe(false);
    });

    it("writes the pref, the variable and the marker as the slider moves", () => {
      const section = buildAccessibilityTab(owner.signal);
      drag(slider(section), 40);
      expect(localStorage.getItem(`${PREFIX}saturation`)).toBe("40");
      expect(root.style.getPropertyValue("--ui-saturation")).toBe("0.4");
      expect(root.classList.contains("custom-saturation")).toBe(true);
      expect(section.querySelector(".slider-val")?.textContent).toBe("40%");

      drag(slider(section), 100);
      expect(root.style.getPropertyValue("--ui-saturation")).toBe("1");
      expect(root.classList.contains("custom-saturation")).toBe(false);
    });

    it("allows 0 % (fully grey)", () => {
      const section = buildAccessibilityTab(owner.signal);
      drag(slider(section), 0);
      expect(root.style.getPropertyValue("--ui-saturation")).toBe("0");
      expect(root.classList.contains("custom-saturation")).toBe(true);
    });

    it("is applied at startup from the stored pref", () => {
      localStorage.setItem(`${PREFIX}saturation`, "25");
      applyStoredAppearance();
      expect(root.style.getPropertyValue("--ui-saturation")).toBe("0.25");
      expect(root.classList.contains("custom-saturation")).toBe(true);
    });

    it.each([
      ['"abc"', "a string"],
      ["500", "above the range"],
      ["-5", "below the range"],
      ["1e999", "not finite"],
      ["null", "null"],
    ])("falls back to the default for a stored %s (%s)", (raw) => {
      localStorage.setItem(`${PREFIX}saturation`, raw);
      expect(effectiveSaturation()).toBe(DEFAULT_SATURATION_PCT);
      applySaturation();
      expect(root.style.getPropertyValue("--ui-saturation")).toBe("1");
      expect(root.classList.contains("custom-saturation")).toBe(false);
      // The slider shows what is applied, not the bad value.
      expect(slider(buildAccessibilityTab(owner.signal)).value).toBe("100");
    });
  });
});
