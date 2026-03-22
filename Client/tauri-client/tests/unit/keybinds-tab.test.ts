import { describe, it, expect } from "vitest";
import { buildKeybindsTab } from "../../src/components/settings/KeybindsTab";

describe("KeybindsTab", () => {
  it("returns a div with settings-pane class", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("settings-pane active");
  });

  it("renders section headers instead of h1", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const headers = el.querySelectorAll(".keybind-section-header");
    expect(headers.length).toBe(3);
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toEqual(["Navigation", "Communication", "Messages"]);
  });

  it("renders Push to Talk keybind row", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    // 1 PTT + 3 Navigation + 3 Communication + 2 Messages = 9
    expect(rows.length).toBe(9);
    const pttLabel = rows[0]!.querySelector(".setting-label");
    expect(pttLabel!.textContent).toBe("Push to Talk");
  });

  it("renders Quick Switcher keybind row with Ctrl + K", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    const kbd = rows[1]!.querySelector(".kbd");
    expect(kbd!.textContent).toBe("Ctrl + K");
  });

  it("shows fallback for PTT when not configured", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    const kbd = rows[0]!.querySelector(".kbd");
    expect(kbd!.textContent).toBe("Not set");
  });
});
