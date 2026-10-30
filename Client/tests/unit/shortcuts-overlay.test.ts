import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { closeShortcutsOverlay, openShortcutsOverlay } from "../../src/components/ShortcutsOverlay";
import { saveGlobalShortcutVk } from "../../src/lib/voiceShortcuts";
import { saveKeybind } from "../../src/lib/prefs/keybinds";
import { KEYBIND_GROUPS } from "../../src/lib/prefs/keybindCatalog";
import { dialogOpen } from "../../src/lib/dialogOpen";
import { settingsText as t } from "../../src/i18n/settings";

const overlay = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid='shortcuts-overlay']");

function key(init: KeyboardEventInit, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("ShortcutsOverlay", () => {
  let opener: HTMLButtonElement;

  beforeEach(() => {
    localStorage.clear();
    opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
  });

  afterEach(() => {
    key({ key: "Escape" });
    opener.remove();
  });

  it("is a labelled modal dialog counted by dialogOpen()", () => {
    expect(dialogOpen()).toBe(false);
    openShortcutsOverlay();

    const dialog = overlay()!.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(dialog.getAttribute("aria-labelledby")!);
    expect(heading?.textContent).toBe("Keyboard Shortcuts");
    expect(dialogOpen()).toBe(true);
  });

  it("renders every catalog row under its group heading", () => {
    openShortcutsOverlay();
    const headings = Array.from(overlay()!.querySelectorAll(".keybind-section-header")).map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(KEYBIND_GROUPS.map((g) => t(g.title)));

    const rows = Array.from(overlay()!.querySelectorAll(".keybind-row")).map(
      (r) =>
        `${r.querySelector(".setting-label")?.textContent}|${r.querySelector(".kbd")?.textContent}`,
    );
    for (const group of KEYBIND_GROUPS) {
      for (const r of group.rows) expect(rows).toContain(`${t(r.action)}|${t(r.combo)}`);
    }
  });

  it("shows the current global mute and deafen keys, read-only", () => {
    openShortcutsOverlay();
    const rows = new Map(
      Array.from(overlay()!.querySelectorAll(".keybind-row")).map((r) => [
        r.querySelector(".setting-label")?.textContent,
        r.querySelector(".kbd")?.textContent,
      ]),
    );
    expect(rows.get("Toggle Mute")).toBe("Ctrl + Shift + M");
    expect(rows.get("Toggle Deafen")).toBe("Ctrl + Shift + D");
    expect(overlay()!.querySelectorAll("input, select").length).toBe(0);
  });

  const labelled = (): Map<string | null | undefined, string | null | undefined> =>
    new Map(
      Array.from(overlay()!.querySelectorAll(".keybind-row")).map((r) => [
        r.querySelector(".setting-label")?.textContent,
        r.querySelector(".kbd")?.textContent,
      ]),
    );

  it("shows a rebound row's binding, not its default", () => {
    saveKeybind("search", { vk: 0x4a, ctrl: true, shift: false, alt: false });
    saveKeybind("emojiPicker", null);
    openShortcutsOverlay();
    const rows = labelled();
    expect(rows.get("Search Messages")).toBe("Ctrl + J");
    expect(rows.get("Emoji Picker")).toBe("Not set");
    expect(rows.get("GIF Picker")).toBe("Ctrl + G");
  });

  it("lists screen share and disconnect only once they are bound", () => {
    openShortcutsOverlay();
    expect(labelled().has("Toggle Screen Share")).toBe(false);
    expect(labelled().has("Disconnect from Voice")).toBe(false);
    closeShortcutsOverlay();

    saveKeybind("toggleScreenshare", { vk: 0x75, ctrl: false, shift: false, alt: false });
    openShortcutsOverlay();
    expect(labelled().get("Toggle Screen Share")).toBe("F6");
    expect(labelled().has("Disconnect from Voice")).toBe(false);
  });

  it("reads a rebound mute key when it opens", () => {
    saveGlobalShortcutVk("mute", 0x4b); // K
    openShortcutsOverlay();
    const muteRow = Array.from(overlay()!.querySelectorAll(".keybind-row")).find(
      (r) => r.querySelector(".setting-label")?.textContent === "Toggle Mute",
    );
    expect(muteRow?.querySelector(".kbd")?.textContent).toBe("Ctrl + Shift + K");
  });

  it("stops listening for Ctrl+/ once closed", () => {
    openShortcutsOverlay();
    key({ key: "Escape" });
    expect(overlay()).toBeNull();
    expect(key({ key: "/", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("closeShortcutsOverlay closes an open overlay and is safe when none is open", () => {
    closeShortcutsOverlay();
    openShortcutsOverlay();
    closeShortcutsOverlay();
    expect(overlay()).toBeNull();
    expect(dialogOpen()).toBe(false);
  });

  it("moves focus into the dialog and keeps Tab inside it", () => {
    openShortcutsOverlay();
    const close = overlay()!.querySelector<HTMLButtonElement>("[data-testid='shortcuts-close']")!;
    expect(document.activeElement).toBe(close);

    // The close button is the only focusable control: Tab and Shift+Tab stay on it.
    const tab = key({ key: "Tab" }, close);
    expect(tab.defaultPrevented).toBe(true);
    expect(overlay()!.contains(document.activeElement)).toBe(true);
    key({ key: "Tab", shiftKey: true }, close);
    expect(overlay()!.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the opener", () => {
    openShortcutsOverlay();
    key({ key: "Escape" });

    expect(overlay()).toBeNull();
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes on its close button and returns focus", () => {
    openShortcutsOverlay();
    overlay()!.querySelector<HTMLButtonElement>("[data-testid='shortcuts-close']")!.click();

    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a second Ctrl+/ and on Cmd+/, ignoring auto-repeat", () => {
    openShortcutsOverlay();
    key({ key: "/", ctrlKey: true, repeat: true });
    expect(overlay()).not.toBeNull();

    const event = key({ key: "/", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(overlay()).toBeNull();

    openShortcutsOverlay();
    key({ key: "/", metaKey: true });
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opening twice leaves one dialog, and it reopens after a close", () => {
    openShortcutsOverlay();
    openShortcutsOverlay();
    expect(document.querySelectorAll("[data-testid='shortcuts-overlay']").length).toBe(1);

    key({ key: "Escape" });
    openShortcutsOverlay();
    expect(overlay()).not.toBeNull();
  });
});
