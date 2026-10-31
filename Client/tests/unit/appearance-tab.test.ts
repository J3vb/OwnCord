import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAppearanceTab } from "../../src/features/settings/AppearanceTab";
import { refreshTimeFormat } from "@lib/text/timeFormat";

const { mockGetActiveThemeName, mockRestoreTheme } = vi.hoisted(() => ({
  mockGetActiveThemeName: vi.fn(() => "neon-glow"),
  mockRestoreTheme: vi.fn(),
}));

vi.mock("@stores/ui.store", () => ({
  setTheme: vi.fn(),
}));

vi.mock("@lib/prefs/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/prefs/themes")>()),
  getActiveThemeName: mockGetActiveThemeName,
  restoreTheme: mockRestoreTheme,
}));

describe("AppearanceTab — Accessibility", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    refreshTimeFormat();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
  });

  afterEach(() => {
    container.remove();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("theme tiles are <button> elements", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    // Four palettes plus Sync with computer.
    expect(tiles.length).toBe(5);

    for (const tile of tiles) {
      expect(tile.tagName).toBe("BUTTON");
    }
  });

  it("theme container has role=radiogroup", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const themeRow = container.querySelector(".theme-options");
    expect(themeRow?.getAttribute("role")).toBe("radiogroup");
  });

  it("theme and accent groups are one Tab stop with arrow-key movement (A11Y-09)", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    for (const group of [".theme-options", ".accent-swatches"]) {
      const row = container.querySelector(group)!;
      // Exactly one cell in the group is tabbable.
      expect(row.querySelectorAll("[role='radio'][tabindex='0']").length).toBe(1);

      const first = row.querySelector("[tabindex='0']") as HTMLElement;
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const next = row.querySelector("[tabindex='0']") as HTMLElement;
      expect(next).not.toBe(first);
      expect(document.activeElement).toBe(next);

      // Enter activates the focused cell through its own click handler.
      next.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(next.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("theme tiles have role=radio and aria-checked", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    for (const tile of tiles) {
      expect(tile.getAttribute("role")).toBe("radio");
      expect(["true", "false"]).toContain(tile.getAttribute("aria-checked"));
    }

    // Active tile should have aria-checked=true
    const active = container.querySelector(".theme-opt.active");
    expect(active?.getAttribute("aria-checked")).toBe("true");
  });

  it("activates theme tile on Enter key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const midnight = tiles[2] as HTMLElement;

    midnight.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(midnight.classList.contains("active")).toBe(true);
    expect(midnight.getAttribute("aria-checked")).toBe("true");
  });

  it("activates theme tile on Space key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const dark = tiles[0] as HTMLElement;

    dark.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(dark.classList.contains("active")).toBe(true);
  });

  it("uses a real preset for the default accent state", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeSwatch = container.querySelector(".accent-swatch.active") as HTMLElement;
    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;

    expect(activeSwatch).not.toBeNull();
    expect(activeSwatch.title).toBe("#00c8ff");
    expect(hexInput.placeholder).toBe("00c8ff");
  });

  it("uses blurple as the displayed default accent for non-neon built-in themes", () => {
    mockGetActiveThemeName.mockReturnValue("dark");

    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeSwatch = container.querySelector(".accent-swatch.active") as HTMLElement;
    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;

    expect(activeSwatch).not.toBeNull();
    expect(activeSwatch.title).toBe("#5865f2");
    expect(hexInput.placeholder).toBe("5865f2");
  });

  it("updates the displayed default accent when switching built-in themes without an override", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const dark = tiles[0] as HTMLElement;
    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;

    dark.click();

    const activeSwatch = container.querySelector(".accent-swatch.active") as HTMLElement;
    expect(activeSwatch.title).toBe("#5865f2");
    expect(hexInput.value).toBe("5865f2");
    expect(hexInput.placeholder).toBe("5865f2");
  });

  it("keeps a saved accent applied after switching themes", () => {
    // applyThemeByName strips every inline custom property from <body>, so the
    // accent override has to be re-applied or the theme's own --accent wins.
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    (swatches[1] as HTMLElement).click(); // #57f287
    expect(document.body.style.getPropertyValue("--accent")).toBe("#57f287");

    const tiles = container.querySelectorAll(".theme-opt");
    (tiles[0] as HTMLElement).click(); // switch to "dark"

    expect(document.body.style.getPropertyValue("--accent")).toBe("#57f287");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#57f287");
  });

  it("restores a custom active theme without forcing a built-in tile active", () => {
    mockGetActiveThemeName.mockReturnValue("custom-sunrise");

    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeTile = container.querySelector(".theme-opt.active");
    expect(activeTile).toBeNull();
    expect(mockRestoreTheme).toHaveBeenCalledTimes(1);
  });

  it("does not inject an accent override when no accent has been saved", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(document.body.style.getPropertyValue("--accent")).toBe("");
  });

  // --- Accent color swatch selection ---

  it("activates a swatch when clicked and saves accent color", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    const greenSwatch = swatches[1] as HTMLElement; // #57f287

    greenSwatch.click();

    expect(greenSwatch.classList.contains("active")).toBe(true);
    expect(greenSwatch.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("owncord:settings:accentColor")).toBe('"#57f287"');
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#57f287");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#57f287");
  });

  it("deactivates previous swatch when a new one is selected", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    const first = swatches[0] as HTMLElement;
    const second = swatches[1] as HTMLElement;

    first.click();
    expect(first.classList.contains("active")).toBe(true);

    second.click();
    expect(first.classList.contains("active")).toBe(false);
    expect(first.getAttribute("aria-checked")).toBe("false");
    expect(second.classList.contains("active")).toBe(true);
  });

  it("activates swatch on Enter key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    const swatch = swatches[2] as HTMLElement;

    swatch.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(swatch.classList.contains("active")).toBe(true);
  });

  it("activates swatch on Space key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    const swatch = swatches[3] as HTMLElement;

    swatch.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(swatch.classList.contains("active")).toBe(true);
  });

  // --- Hex input ---

  it("applies accent color when a valid 6-char hex is entered", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    hexInput.value = "ff00ff";
    hexInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(localStorage.getItem("owncord:settings:accentColor")).toBe('"#ff00ff"');
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff00ff");
  });

  it("strips invalid hex characters from input", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    hexInput.value = "zz00gg";
    hexInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(hexInput.value).toBe("00");
  });

  it("does not apply accent for incomplete hex input", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    hexInput.value = "abc";
    hexInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Should not have saved — partial hex
    expect(localStorage.getItem("owncord:settings:accentColor")).toBeNull();
  });

  // --- Font size slider ---

  it("updates font size on slider input", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const slider = container.querySelector(".settings-slider") as HTMLInputElement;
    const label = container.querySelector(".slider-val")!;

    slider.value = "18";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(label.textContent).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("18px");
    expect(localStorage.getItem("owncord:settings:fontSize")).toBe("18");
  });

  // --- Compact mode toggle ---

  it("toggles compact mode and persists to localStorage", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const toggle = container.querySelector(".setting-row .toggle") as HTMLElement;

    toggle.click();
    expect(document.documentElement.classList.contains("compact-mode")).toBe(true);
    expect(localStorage.getItem("owncord:settings:compactMode")).toBe("true");

    toggle.click();
    expect(document.documentElement.classList.contains("compact-mode")).toBe(false);
    expect(localStorage.getItem("owncord:settings:compactMode")).toBe("false");
  });

  // --- Theme switching ---

  it("clicking a theme tile updates aria-checked and active class for all tiles", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const midnight = tiles[2] as HTMLElement;

    midnight.click();

    for (const tile of tiles) {
      if (tile === midnight) {
        expect(tile.classList.contains("active")).toBe(true);
        expect(tile.getAttribute("aria-checked")).toBe("true");
      } else {
        expect(tile.classList.contains("active")).toBe(false);
        expect(tile.getAttribute("aria-checked")).toBe("false");
      }
    }
  });

  // --- Stored accent overrides default on theme switch ---

  it("does not change accent display when switching themes if an override is stored", () => {
    localStorage.setItem("owncord:settings:accentColor", '"#ff0000"');
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const dark = tiles[0] as HTMLElement;

    dark.click();

    // hexInput should still show the stored override, not the theme default
    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    expect(hexInput.value).toBe("ff0000");
  });

  // --- Applies stored accent on render ---

  it("applies stored accent color on initial render", () => {
    localStorage.setItem("owncord:settings:accentColor", '"#abcdef"');
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#abcdef");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#abcdef");
  });

  // --- Built-in theme applies CSS variables ---

  it("applies built-in theme CSS variables when a tile is clicked", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-opt");
    const light = tiles[3] as HTMLElement;

    light.click();

    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--text-normal")).toBe("#2a2c31");
  });

  // --- Hex input truncates to 6 chars ---

  it("truncates hex input to 6 characters maximum", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    hexInput.value = "aabbccdd";
    hexInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(hexInput.value).toBe("aabbcc");
  });

  // --- Hex input syncs swatch display ---

  it("syncs swatch active state when hex input matches a preset", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    hexInput.value = "57f287"; // green preset
    hexInput.dispatchEvent(new Event("input", { bubbles: true }));

    // The green swatch should now be active
    expect(hexInput.value).toBe("57f287");
  });

  // --- Renders all 10 accent swatches ---

  it("names the custom accent input and describes the Q8 readability fallback", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const hexInput = container.querySelector(".accent-hex-row input") as HTMLInputElement;
    expect(hexInput.getAttribute("aria-label")).toBe("Custom accent color (hex)");
    const note = document.getElementById(hexInput.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe(
      "Custom colours may reduce readability; text and focus indicators fall back to a readable colour when needed, and High Contrast restores tested colours.",
    );
  });

  it("renders all 10 accent color swatches", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    expect(swatches.length).toBe(10);
  });

  // --- Swatches have proper ARIA ---

  it("accent swatches have role=radio and aria-label", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const swatches = container.querySelectorAll(".accent-swatch");
    for (const swatch of swatches) {
      expect(swatch.getAttribute("role")).toBe("radio");
      expect(swatch.getAttribute("aria-label")).toBeTruthy();
    }
  });

  // --- Renders hex prefix ---

  it("renders # prefix before hex input", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const prefix = container.querySelector(".accent-hex-prefix");
    expect(prefix?.textContent).toBe("#");
  });

  // --- Time format (12h / 24h) ---

  it("shows a Time Format radiogroup defaulting to 12-hour", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const group = container.querySelector('[data-testid="time-format"]');
    expect(group?.getAttribute("role")).toBe("radiogroup");
    const selected = group!.querySelector("[aria-checked='true']") as HTMLElement;
    expect(selected.dataset["value"]).toBe("12h");
  });

  it("saves 24-hour and updates the selection when chosen", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const option = container.querySelector('[data-testid="time-format-24h"]') as HTMLElement;
    option.click();

    expect(localStorage.getItem("owncord:settings:timeFormat")).toBe('"24h"');
    expect(option.getAttribute("aria-checked")).toBe("true");
  });

  it("loads a stored 24-hour choice as the active option", () => {
    localStorage.setItem("owncord:settings:timeFormat", '"24h"');
    refreshTimeFormat();
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const selected = container
      .querySelector('[data-testid="time-format"]')!
      .querySelector("[aria-checked='true']") as HTMLElement;
    expect(selected.dataset["value"]).toBe("24h");
  });
});

describe("AppearanceTab - member list position (3C-6b)", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("member layout radiogroup saves memberListLayout", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const group = container.querySelector('[data-testid="member-layout"]')!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Member list position");
    const checked = () =>
      group.querySelector<HTMLElement>("[aria-checked='true']")!.dataset["value"];
    // No stored layout: the default is the right column (3C-6c).
    expect(checked()).toBe("right");

    const events: string[] = [];
    const onPref = (e: Event): void => {
      events.push((e as CustomEvent<{ key: string }>).detail.key);
    };
    window.addEventListener("owncord:pref-change", onPref);
    container.querySelector<HTMLElement>('[data-testid="member-layout-left"]')!.click();
    window.removeEventListener("owncord:pref-change", onPref);

    expect(localStorage.getItem("owncord:settings:memberListLayout")).toBe('"left"');
    expect(events).toContain("memberListLayout");
    expect(checked()).toBe("left");

    container.querySelector<HTMLElement>('[data-testid="member-layout-right"]')!.click();
    expect(localStorage.getItem("owncord:settings:memberListLayout")).toBe('"right"');
    expect(checked()).toBe("right");
  });

  it("loads a stored left layout as the active option", () => {
    localStorage.setItem("owncord:settings:memberListLayout", '"left"');
    container.appendChild(buildAppearanceTab(ac.signal));
    const selected = container
      .querySelector('[data-testid="member-layout"]')!
      .querySelector<HTMLElement>("[aria-checked='true']")!;
    expect(selected.dataset["value"]).toBe("left");
  });

  it("loads a stored right layout as the active option", () => {
    localStorage.setItem("owncord:settings:memberListLayout", '"right"');
    container.appendChild(buildAppearanceTab(ac.signal));
    const selected = container
      .querySelector('[data-testid="member-layout"]')!
      .querySelector<HTMLElement>("[aria-checked='true']")!;
    expect(selected.dataset["value"]).toBe("right");
  });
});

describe("AppearanceTab - system theme", () => {
  let container: HTMLDivElement;
  let ac: AbortController;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
    ac = new AbortController();
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: true,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    ac.abort();
    container.remove();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("style");
  });

  it("adds a Sync with computer tile that stores the system choice", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const tile = container.querySelector<HTMLElement>(".theme-opt.system")!;
    expect(tile.textContent).toBe("Sync with computer");
    tile.click();
    expect(localStorage.getItem("owncord:theme:active")).toBe("system");
    expect(tile.getAttribute("aria-checked")).toBe("true");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });

  it("marks the system tile active when system is the stored choice", () => {
    mockGetActiveThemeName.mockReturnValue("system");
    container.appendChild(buildAppearanceTab(ac.signal));
    expect(container.querySelector(".theme-opt.active")?.classList.contains("system")).toBe(true);
  });

  it("refreshes the default accent when the OS flips light/dark under system", () => {
    mockGetActiveThemeName.mockReturnValue("system");
    let dark = true;
    let onChange: (() => void) | null = null;
    vi.stubGlobal("matchMedia", (media: string) => ({
      get matches() {
        return dark;
      },
      media,
      addEventListener: (_t: string, cb: () => void) => {
        onChange = cb;
      },
      removeEventListener: vi.fn(),
    }));
    container.appendChild(buildAppearanceTab(ac.signal));
    const hex = container.querySelector<HTMLInputElement>(".accent-hex-row input")!;
    expect(hex.value).toBe("5865f2");
    expect(container.querySelectorAll(".accent-swatch.active")).toHaveLength(1);

    dark = false;
    onChange!();

    expect(hex.value).toBe("4f5bd5");
    expect(hex.placeholder).toBe("4f5bd5");
    // Light's default accent is not a preset, so no swatch stays selected.
    expect(container.querySelectorAll(".accent-swatch.active")).toHaveLength(0);
  });
});
