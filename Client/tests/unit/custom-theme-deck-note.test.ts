import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    fileSaver: { pickSaveLocation: vi.fn(), writeFile: vi.fn() },
    shareSheet: { available: false, shareFile: vi.fn() },
  },
}));

import { buildCustomThemeSection } from "../../src/features/custom-themes/customThemeSection";
import { saveScreenLayout, setRunningScreenLayout } from "../../src/lib/prefs/screenLayout";

const NOTE = "Command Deck keeps your theme's colours. It sets its own panel shapes.";

describe("custom theme section: Command Deck note", () => {
  let owner: AbortController;

  beforeEach(() => {
    localStorage.clear();
    owner = new AbortController();
  });

  afterEach(() => {
    owner.abort();
    setRunningScreenLayout("classic");
  });

  it("note when Deck is running", () => {
    setRunningScreenLayout("deck");
    const section = buildCustomThemeSection(owner.signal);
    const notes = [...section.querySelectorAll("p.setting-note")];
    expect(notes.map((n) => n.textContent)).toEqual([NOTE]);
    // Between the description and the theme list.
    expect(notes[0]!.previousElementSibling?.classList.contains("setting-desc")).toBe(true);
    expect(notes[0]!.nextElementSibling?.classList.contains("custom-theme-list")).toBe(true);
  });

  it("no note in Classic, even with Deck stored", () => {
    saveScreenLayout("deck");
    setRunningScreenLayout("classic");
    const section = buildCustomThemeSection(owner.signal);
    expect(section.querySelector("p.setting-note")).toBeNull();
    expect(section.textContent).not.toContain("Command Deck");
  });
});
