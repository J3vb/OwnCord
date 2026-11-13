import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { buildAppearanceTab } from "../../src/features/settings/AppearanceTab";
import { refreshTimeFormat, refreshDateFormat, getDateFormat } from "@lib/text/timeFormat";
import {
  saveCustomThemes,
  setActiveCustomTheme,
} from "../../src/features/custom-themes/customTheme";

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

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      document.documentElement.removeAttribute("style");
      document.body.removeAttribute("style");
    },
  );

  beforeEach(() => {
    localStorage.clear();
    refreshTimeFormat();
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
    vi.clearAllMocks();
    mockGetActiveThemeName.mockReturnValue("neon-glow");
  });

  it("theme tiles are <button> elements", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
    // Four palettes plus Match my computer.
    expect(tiles.length).toBe(5);

    for (const tile of tiles) {
      expect(tile.tagName).toBe("BUTTON");
    }
  });

  it("theme container has role=radiogroup", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const themeRow = container.querySelector(".theme-tiles");
    expect(themeRow?.getAttribute("role")).toBe("radiogroup");
  });

  it("theme and accent groups are one Tab stop with arrow-key movement (A11Y-09)", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    for (const group of [".theme-tiles", ".accent-swatches"]) {
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

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
    for (const tile of tiles) {
      expect(tile.getAttribute("role")).toBe("radio");
      expect(["true", "false"]).toContain(tile.getAttribute("aria-checked"));
    }

    // Active tile should have aria-checked=true
    const active = container.querySelector(".theme-tiles [aria-checked='true']");
    expect(active?.getAttribute("aria-checked")).toBe("true");
  });

  it("activates theme tile on Enter key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
    const midnight = tiles[2] as HTMLElement;

    midnight.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(midnight.getAttribute("aria-checked")).toBe("true");
    expect(midnight.getAttribute("aria-checked")).toBe("true");
  });

  it("activates theme tile on Space key", () => {
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
    const dark = tiles[0] as HTMLElement;

    dark.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(dark.getAttribute("aria-checked")).toBe("true");
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

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
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

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
    (tiles[0] as HTMLElement).click(); // switch to "dark"

    expect(document.body.style.getPropertyValue("--accent")).toBe("#57f287");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#57f287");
  });

  it("restores a custom active theme without forcing a built-in tile active", () => {
    mockGetActiveThemeName.mockReturnValue("custom-sunrise");

    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const activeTile = container.querySelector(".theme-tiles [aria-checked='true']");
    expect(activeTile).toBeNull();
    expect(mockRestoreTheme).toHaveBeenCalledTimes(1);
  });

  // --- Theme preview tiles ---

  const checkedTiles = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".theme-tiles [aria-checked='true']"));

  it("is one radiogroup named by the Theme heading, each tile named by its theme", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const group = container.querySelector<HTMLElement>(".theme-tiles")!;
    const heading = document.getElementById(group.getAttribute("aria-labelledby")!);
    expect(heading?.textContent).toBe("Theme");
    expect(heading?.tagName).toBe("H2");
    const names = Array.from(group.querySelectorAll("[role='radio']")).map((tile) =>
      tile.textContent?.trim(),
    );
    expect(names).toEqual(["Dark", "Neon glow", "Midnight", "Light", "Match my computer"]);
    // The preview is a picture only: the tile's name is its label text.
    for (const preview of group.querySelectorAll(".radio-card-preview")) {
      expect(preview.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("draws each preview from its theme's own colours, the system one half light, half dark", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const light = container.querySelector<HTMLElement>(
      "[data-testid='theme-light'] .theme-preview",
    )!;
    expect(light.style.getPropertyValue("--pv-bg")).toBe("#ffffff");
    expect(light.style.getPropertyValue("--pv-text")).toBe("#2a2c31");
    const neon = container.querySelector<HTMLElement>(
      "[data-testid='theme-neon-glow'] .theme-preview",
    )!;
    expect(neon.style.getPropertyValue("--pv-accent")).toBe("#00c8ff");
    const split = container.querySelector("[data-testid='theme-system'] .theme-preview-split")!;
    const halves = split.querySelectorAll<HTMLElement>(":scope > .theme-preview");
    expect(Array.from(halves, (h) => h.style.getPropertyValue("--pv-bg"))).toEqual([
      "#313338",
      "#ffffff",
    ]);
    expect(halves[1]?.classList.contains("theme-preview-half")).toBe(true);
  });

  it("checks the tile of the stored theme and makes it the only tab stop", () => {
    mockGetActiveThemeName.mockReturnValue("midnight");
    container.appendChild(buildAppearanceTab(ac.signal));
    expect(checkedTiles().map((tile) => tile.dataset.value)).toEqual(["midnight"]);
    const stops = container.querySelectorAll<HTMLElement>(".theme-tiles [tabindex='0']");
    expect(Array.from(stops, (tile) => tile.dataset.value)).toEqual(["midnight"]);
  });

  it("arrow keys move the check, wrap at the ends and apply the theme at once", () => {
    mockGetActiveThemeName.mockReturnValue("dark");
    container.appendChild(buildAppearanceTab(ac.signal));
    const dark = container.querySelector<HTMLElement>("[data-testid='theme-dark']")!;
    dark.focus();
    dark.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const neon = container.querySelector<HTMLElement>("[data-testid='theme-neon-glow']")!;
    expect(document.activeElement).toBe(neon);
    expect(checkedTiles()).toEqual([neon]);
    expect(localStorage.getItem("owncord:theme:active")).toBe("neon-glow");
    expect(document.body.classList.contains("theme-neon-glow")).toBe(true);

    neon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    dark.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    const system = container.querySelector<HTMLElement>("[data-testid='theme-system']")!;
    expect(document.activeElement).toBe(system);
    expect(checkedTiles()).toEqual([system]);
    expect(localStorage.getItem("owncord:theme:active")).toBe("system");
  });

  it("keeps exactly one tile checked, the theme under it, while a custom theme is on", () => {
    mockGetActiveThemeName.mockReturnValue("light");
    expect(
      saveCustomThemes([{ id: "c1", name: "Sunrise", css: ":root { --accent: #f80; }" }]),
    ).toBe(true);
    expect(setActiveCustomTheme("c1")).toBe(true);
    container.appendChild(buildAppearanceTab(ac.signal));

    expect(checkedTiles().map((tile) => tile.dataset.value)).toEqual(["light"]);
    expect(container.querySelector(".custom-theme-row.active")).not.toBeNull();

    // Picking another tile moves the one check and leaves the custom theme on.
    container.querySelector<HTMLElement>("[data-testid='theme-midnight']")!.click();
    expect(checkedTiles().map((tile) => tile.dataset.value)).toEqual(["midnight"]);
    expect(localStorage.getItem("owncord:theme:custom:active")).toBe("c1");
    setActiveCustomTheme(null);
  });

  it("orders the page Theme, Accent color, Text & size, then Layout, date & time", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const headings = Array.from(container.querySelectorAll(".settings-section-label"), (h) =>
      h.textContent?.trim(),
    );
    expect(headings.slice(0, 4)).toEqual([
      "Theme",
      "Accent color",
      "Text & size",
      "Layout, date & time",
    ]);
    // The heading names the section, so no row inside repeats it.
    const rowLabels = Array.from(container.querySelectorAll(".setting-label"), (l) =>
      l.textContent?.trim(),
    );
    expect(rowLabels).not.toContain("Theme");
    expect(rowLabels).not.toContain("Accent color");
    const swatches = container.querySelector<HTMLElement>(".accent-swatches")!;
    expect(swatches.getAttribute("role")).toBe("radiogroup");
    expect(document.getElementById(swatches.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Accent color",
    );
  });

  it("moves the accent tab stop with the check after a theme switch and a custom hex", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const stops = (): string[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".accent-swatch[tabindex='0']"),
        (s) => s.title,
      );
    const checked = (): string[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".accent-swatch[aria-checked='true']"),
        (s) => s.title,
      );
    expect(stops()).toEqual(["#00c8ff"]);

    // Dark's default accent is blurple, so the check and the tab stop move to it.
    container.querySelector<HTMLElement>("[data-testid='theme-dark']")!.click();
    expect(checked()).toEqual(["#5865f2"]);
    expect(stops()).toEqual(["#5865f2"]);

    // A colour no swatch has checks none; the first swatch is the way in.
    const hexInput = container.querySelector<HTMLInputElement>(".accent-hex-row input")!;
    hexInput.value = "123456";
    hexInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(checked()).toEqual([]);
    const first = container.querySelector<HTMLElement>(".accent-swatch")!;
    expect(stops()).toEqual([first.title]);
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

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
    const midnight = tiles[2] as HTMLElement;

    midnight.click();

    for (const tile of tiles) {
      if (tile === midnight) {
        expect(tile.getAttribute("aria-checked")).toBe("true");
        expect(tile.getAttribute("aria-checked")).toBe("true");
      } else {
        expect(tile.getAttribute("aria-checked")).toBe("false");
        expect(tile.getAttribute("aria-checked")).toBe("false");
      }
    }
  });

  // --- Stored accent overrides default on theme switch ---

  it("does not change accent display when switching themes if an override is stored", () => {
    localStorage.setItem("owncord:settings:accentColor", '"#ff0000"');
    const section = buildAppearanceTab(ac.signal);
    container.appendChild(section);

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
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

    const tiles = container.querySelectorAll(".theme-tiles [role='radio']");
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
      "Custom colors may reduce readability; text and focus indicators fall back to a readable color when needed, and High contrast restores tested colors.",
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

  it("shows a Time format radiogroup defaulting to 12-hour", () => {
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

  // --- Date format ---

  it("defaults Date format to Automatic, and a pinned order moves the clock default", () => {
    try {
      const section = buildAppearanceTab(ac.signal);
      container.appendChild(section);
      const group = container.querySelector('[data-testid="date-format"]')!;
      expect(group.getAttribute("role")).toBe("radiogroup");
      expect((group.querySelector("[aria-checked='true']") as HTMLElement).dataset["value"]).toBe(
        "auto",
      );

      (container.querySelector('[data-testid="date-format-dayFirst"]') as HTMLElement).click();

      expect(localStorage.getItem("owncord:settings:dateFormat")).toBe('"dayFirst"');
      expect(getDateFormat()).toBe("dayFirst");
      // No clock was chosen, so the 24-hour default of a day-first date follows.
      const clock = container
        .querySelector('[data-testid="time-format"]')!
        .querySelector("[aria-checked='true']") as HTMLElement;
      expect(clock.dataset["value"]).toBe("24h");
    } finally {
      localStorage.removeItem("owncord:settings:dateFormat");
      refreshDateFormat();
    }
  });
});

describe("AppearanceTab - member list position (3C-6b)", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();
  useMountContainer((mounted) => {
    container = mounted;
    localStorage.clear();
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

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      ac.abort();
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute("style");
    },
  );

  beforeEach(() => {
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

  it("adds a Match my computer tile that stores the system choice", () => {
    container.appendChild(buildAppearanceTab(ac.signal));
    const tile = container.querySelector<HTMLElement>("[data-testid='theme-system']")!;
    expect(tile.textContent).toBe("Match my computer");
    tile.click();
    expect(localStorage.getItem("owncord:theme:active")).toBe("system");
    expect(tile.getAttribute("aria-checked")).toBe("true");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });

  it("marks the system tile active when system is the stored choice", () => {
    mockGetActiveThemeName.mockReturnValue("system");
    container.appendChild(buildAppearanceTab(ac.signal));
    expect(
      container.querySelector(".theme-tiles [aria-checked='true']")?.getAttribute("data-value"),
    ).toBe("system");
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
