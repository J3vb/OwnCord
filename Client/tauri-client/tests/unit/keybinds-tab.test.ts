import { describe, it, expect } from "vitest";
import { buildKeybindsTab } from "../../src/components/settings/KeybindsTab";

describe("KeybindsTab", () => {
  it("returns a div with settings-pane class", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("settings-pane active");
  });

  it("renders a Keybinds header", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const h1 = el.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe("Keybinds");
  });

  it("renders Push to Talk keybind row", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    expect(rows.length).toBe(2);
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
