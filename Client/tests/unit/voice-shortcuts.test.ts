// U6 rebinding: the persisted preference, the webview key capture that feeds
// the Settings control, and the conflict rule the control rejects.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_GLOBAL_DEAFEN_VK,
  DEFAULT_GLOBAL_MUTE_VK,
  GLOBAL_DEAFEN_VK_PREF,
  GLOBAL_MUTE_VK_PREF,
  keyEventToVk,
  loadGlobalShortcutVks,
  saveGlobalShortcutVk,
  shortcutConflict,
} from "../../src/lib/voiceShortcuts";

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, ...init });
}

describe("global voice shortcut preferences", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to Ctrl+Shift+M mute and Ctrl+Shift+D deafen", () => {
    expect(DEFAULT_GLOBAL_MUTE_VK).toBe(0x4d);
    expect(DEFAULT_GLOBAL_DEAFEN_VK).toBe(0x44);
    expect(loadGlobalShortcutVks()).toEqual({ mute: 0x4d, deafen: 0x44 });
  });

  it("persists a binding per action and reads it back", () => {
    saveGlobalShortcutVk("mute", 0x4b); // K
    saveGlobalShortcutVk("deafen", 0x71); // F2
    expect(localStorage.getItem(`owncord:settings:${GLOBAL_MUTE_VK_PREF}`)).toBe("75");
    expect(localStorage.getItem(`owncord:settings:${GLOBAL_DEAFEN_VK_PREF}`)).toBe("113");
    expect(loadGlobalShortcutVks()).toEqual({ mute: 0x4b, deafen: 0x71 });
  });
});

describe("webview key capture", () => {
  it("maps a letter, digit, function and navigation key to its VK", () => {
    expect(keyEventToVk(key("KeyM"))).toBe(0x4d);
    expect(keyEventToVk(key("KeyA"))).toBe(0x41);
    expect(keyEventToVk(key("Digit5"))).toBe(0x35);
    expect(keyEventToVk(key("F2"))).toBe(0x71);
    expect(keyEventToVk(key("ArrowUp"))).toBe(0x26);
    expect(keyEventToVk(key("Numpad4"))).toBe(0x64);
  });

  it("returns null for a modifier or an unmapped key", () => {
    expect(keyEventToVk(key("ShiftLeft"))).toBeNull();
    expect(keyEventToVk(key("ControlRight"))).toBeNull();
    expect(keyEventToVk(key("AltLeft"))).toBeNull();
    expect(keyEventToVk(key("MetaLeft"))).toBeNull();
    expect(keyEventToVk(key("Escape"))).toBeNull();
    expect(keyEventToVk(key("IntlBackslash"))).toBeNull();
  });
});

describe("shortcut conflict", () => {
  const current = { mute: 0x4d, deafen: 0x44 };

  it("rejects a key already bound to the other action", () => {
    expect(shortcutConflict(0x44, "mute", current)).toBe("duplicate");
    expect(shortcutConflict(0x4d, "deafen", current)).toBe("duplicate");
  });

  it("rejects the in-app camera shortcut (Ctrl+Shift+V)", () => {
    expect(shortcutConflict(0x56, "mute", current)).toBe("reserved");
    expect(shortcutConflict(0x56, "deafen", current)).toBe("reserved");
  });

  it("allows a free key, including the action's own current binding", () => {
    expect(shortcutConflict(0x4b, "mute", current)).toBeNull();
    expect(shortcutConflict(0x4d, "mute", current)).toBeNull();
  });
});
