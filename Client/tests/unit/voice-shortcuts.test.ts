// U6 rebinding: the persisted preference, the webview key capture that feeds
// the Settings control, and the conflict rule the control rejects.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_GLOBAL_DEAFEN_VK,
  DEFAULT_GLOBAL_MUTE_VK,
  GLOBAL_DEAFEN_VK_PREF,
  GLOBAL_MUTE_VK_PREF,
  isBindableVk,
  keyEventToVk,
  loadGlobalShortcutVks,
  saveGlobalShortcutVk,
  shortcutConflict,
} from "../../src/lib/voice/voiceShortcuts";
import {
  globalShortcutTakenVks,
  inAppCtrlShiftVks,
  parseKeybinds,
} from "../../src/lib/prefs/keybinds";

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
    expect(keyEventToVk(key("Space"))).toBe(0x20);
  });

  it("returns null for a modifier or an unmapped key", () => {
    expect(keyEventToVk(key("ShiftLeft"))).toBeNull();
    expect(keyEventToVk(key("ControlRight"))).toBeNull();
    expect(keyEventToVk(key("AltLeft"))).toBeNull();
    expect(keyEventToVk(key("MetaLeft"))).toBeNull();
    expect(keyEventToVk(key("Escape"))).toBeNull();
    expect(keyEventToVk(key("IntlBackslash"))).toBeNull();
  });

  it("does not bind Tab, Enter, Backspace or a numpad key", () => {
    expect(keyEventToVk(key("Tab"))).toBeNull();
    expect(keyEventToVk(key("Enter"))).toBeNull();
    expect(keyEventToVk(key("Backspace"))).toBeNull();
    expect(keyEventToVk(key("Numpad4"))).toBeNull();
  });
});

describe("webview key capture on Windows", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140.0",
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("binds the layout VK the poller reads, not the US key position", () => {
    // AZERTY: the key labelled A sits at US position Q, the one labelled M at ;
    expect(keyEventToVk(key("KeyQ", { keyCode: 0x41 }))).toBe(0x41);
    expect(keyEventToVk(key("Semicolon", { keyCode: 0x4d }))).toBe(0x4d);
  });

  it("rejects a numpad key, even when NumLock+Shift reports a navigation VK", () => {
    expect(keyEventToVk(key("Numpad0", { keyCode: 0x60 }))).toBeNull();
    expect(keyEventToVk(key("Numpad4", { keyCode: 0x25 }))).toBeNull();
  });

  it("rejects Tab, Enter, Backspace and modifiers", () => {
    expect(keyEventToVk(key("Tab", { keyCode: 0x09 }))).toBeNull();
    expect(keyEventToVk(key("Enter", { keyCode: 0x0d }))).toBeNull();
    expect(keyEventToVk(key("Backspace", { keyCode: 0x08 }))).toBeNull();
    expect(keyEventToVk(key("ShiftLeft", { keyCode: 0x10 }))).toBeNull();
  });
});

describe("shortcut conflict", () => {
  const current = { mute: 0x4d, deafen: 0x44 };
  // Today's defaults: the camera on Ctrl+Shift+V and upload on Ctrl+Shift+U.
  const defaultInApp = inAppCtrlShiftVks(parseKeybinds(undefined, current));

  it("rejects a key already bound to the other action", () => {
    expect(shortcutConflict(0x44, "mute", current, defaultInApp)).toBe("duplicate");
    expect(shortcutConflict(0x4d, "deafen", current, defaultInApp)).toBe("duplicate");
  });

  it("rejects the in-app camera shortcut (Ctrl+Shift+V)", () => {
    expect(shortcutConflict(0x56, "mute", current, defaultInApp)).toBe("reserved");
    expect(shortcutConflict(0x56, "deafen", current, defaultInApp)).toBe("reserved");
  });

  it("rejects the in-app upload shortcut (Ctrl+Shift+U)", () => {
    expect(shortcutConflict(0x55, "mute", current, defaultInApp)).toBe("reserved");
    expect(shortcutConflict(0x55, "deafen", current, defaultInApp)).toBe("reserved");
  });

  it("allows a free key, including the action's own current binding", () => {
    const taken = globalShortcutTakenVks(parseKeybinds(undefined, current));
    expect(shortcutConflict(0x47, "mute", current, taken)).toBeNull(); // G
    expect(shortcutConflict(0x4d, "mute", current, taken)).toBeNull();
    expect(shortcutConflict(0x44, "deafen", current, taken)).toBeNull();
  });

  it("rejects fixed app keys and keys the OS or a text field keep", () => {
    const taken = globalShortcutTakenVks(parseKeybinds(undefined, current));
    // K quick switcher, 0 zoom reset, Z redo, I/J dev tools, R reload,
    // arrows/Home/End/Insert/Delete word select and edit.
    for (const vk of [
      0x4b, 0x30, 0x5a, 0x49, 0x4a, 0x52, 0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x2d, 0x2e,
    ]) {
      expect(shortcutConflict(vk, "mute", current, taken)).toBe("reserved");
      expect(shortcutConflict(vk, "deafen", current, taken)).toBe("reserved");
    }
  });

  it("the taken set still holds the in-app Ctrl+Shift bindings", () => {
    const eff = parseKeybinds(
      { v: 1, bindings: { toggleCamera: { vk: 0x58, ctrl: true, shift: true, alt: false } } },
      current,
    );
    const taken = globalShortcutTakenVks(eff);
    expect(taken.has(0x58)).toBe(true);
    expect(taken.has(0x56)).toBe(false);
  });

  it("camera moved off V frees V for mute", () => {
    const eff = parseKeybinds(
      { v: 1, bindings: { toggleCamera: { vk: 0x58, ctrl: true, shift: true, alt: false } } },
      current,
    );
    expect(shortcutConflict(0x56, "mute", current, inAppCtrlShiftVks(eff))).toBeNull();
  });

  it("camera on X refuses mute X", () => {
    const eff = parseKeybinds(
      { v: 1, bindings: { toggleCamera: { vk: 0x58, ctrl: true, shift: true, alt: false } } },
      current,
    );
    expect(shortcutConflict(0x58, "mute", current, inAppCtrlShiftVks(eff))).toBe("reserved");
  });

  it("the default in-app set from the effective bindings still reserves V and U", () => {
    const set = inAppCtrlShiftVks(parseKeybinds(undefined, current));
    expect(shortcutConflict(0x56, "mute", current, set)).toBe("reserved");
    expect(shortcutConflict(0x55, "deafen", current, set)).toBe("reserved");
  });
});

describe("global voice shortcut preference keys", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("stores each action under its own key", () => {
    expect(GLOBAL_MUTE_VK_PREF).toBe("globalMuteVk");
    expect(GLOBAL_DEAFEN_VK_PREF).toBe("globalDeafenVk");
    saveGlobalShortcutVk("deafen", 0x71);
    expect(localStorage.getItem("owncord:settings:globalMuteVk")).toBeNull();
    expect(loadGlobalShortcutVks()).toEqual({ mute: 0x4d, deafen: 0x71 });
    saveGlobalShortcutVk("mute", 0x72);
    expect(loadGlobalShortcutVks()).toEqual({ mute: 0x72, deafen: 0x71 });
  });

  it("falls back to the shipped default for a stored value of the wrong type", () => {
    localStorage.setItem("owncord:settings:globalMuteVk", '"M"');
    localStorage.setItem("owncord:settings:globalDeafenVk", "not json");
    expect(loadGlobalShortcutVks()).toEqual({ mute: 0x4d, deafen: 0x44 });
  });
});

describe("bindable key set", () => {
  const BINDABLE = new Set([
    ...Array.from({ length: 26 }, (_, i) => 0x41 + i),
    ...Array.from({ length: 10 }, (_, i) => 0x30 + i),
    ...Array.from({ length: 12 }, (_, i) => 0x70 + i),
    0x20,
    0x21,
    0x22,
    0x23,
    0x24,
    0x25,
    0x26,
    0x27,
    0x28,
    0x2d,
    0x2e,
  ]);

  it("accepts exactly letters, digits, F1-F12 and the navigation keys", () => {
    for (let vk = 0; vk < 256; vk++) {
      expect(isBindableVk(vk), `vk ${vk}`).toBe(BINDABLE.has(vk));
    }
  });
});

describe("webview key capture by physical key", () => {
  it("maps every letter, digit and function key", () => {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(0x41 + i);
      expect(keyEventToVk(key(`Key${letter}`)), letter).toBe(0x41 + i);
    }
    for (let i = 0; i < 10; i++) expect(keyEventToVk(key(`Digit${i}`))).toBe(0x30 + i);
    for (let i = 1; i <= 12; i++) expect(keyEventToVk(key(`F${i}`))).toBe(0x6f + i);
  });

  it("maps the navigation keys", () => {
    const expected: Array<[string, number]> = [
      ["Space", 0x20],
      ["PageUp", 0x21],
      ["PageDown", 0x22],
      ["End", 0x23],
      ["Home", 0x24],
      ["ArrowLeft", 0x25],
      ["ArrowUp", 0x26],
      ["ArrowRight", 0x27],
      ["ArrowDown", 0x28],
      ["Insert", 0x2d],
      ["Delete", 0x2e],
    ];
    for (const [code, vk] of expected) expect(keyEventToVk(key(code)), code).toBe(vk);
  });

  it("leaves the keys past the table unbound", () => {
    for (const code of ["F13", "F0", "KeyAA", "Digit10", "Minus", "Comma", "NumpadEnter", ""]) {
      expect(keyEventToVk(key(code)), code).toBeNull();
    }
  });

  it("ignores the layout keyCode off Windows", () => {
    expect(keyEventToVk(key("Comma", { keyCode: 0x41 }))).toBeNull();
    expect(keyEventToVk(key("KeyA", { keyCode: 0x42 }))).toBe(0x41);
  });
});

describe("webview key capture on Windows by layout key", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
  });
  afterEach(() => vi.restoreAllMocks());

  it("binds the edge keys of each bindable range", () => {
    for (const vk of [0x20, 0x28, 0x2d, 0x2e, 0x30, 0x39, 0x41, 0x5a, 0x70, 0x7b]) {
      expect(keyEventToVk(key("Whatever", { keyCode: vk })), `vk ${vk}`).toBe(vk);
    }
  });

  it("rejects a VK just outside each range", () => {
    for (const vk of [0, 0x1f, 0x29, 0x2c, 0x2f, 0x3a, 0x40, 0x5b, 0x6f, 0x7c, 0xe5]) {
      expect(keyEventToVk(key("KeyA", { keyCode: vk })), `vk ${vk}`).toBeNull();
    }
  });
});

describe("shortcut conflict order", () => {
  const current = { mute: 0x4d, deafen: 0x44 };

  it("calls a key that is both the other action's and an app key a duplicate", () => {
    expect(shortcutConflict(0x44, "mute", current, new Set([0x44]))).toBe("duplicate");
    expect(shortcutConflict(0x4d, "deafen", current, new Set([0x4d]))).toBe("duplicate");
  });

  it("compares against the other action's key, never the action's own", () => {
    expect(shortcutConflict(0x4d, "mute", current, new Set())).toBeNull();
    expect(shortcutConflict(0x44, "deafen", current, new Set())).toBeNull();
  });

  it("reserves exactly the keys in the in-app set", () => {
    const set = new Set([0x50]);
    expect(shortcutConflict(0x50, "mute", current, set)).toBe("reserved");
    expect(shortcutConflict(0x51, "mute", current, set)).toBeNull();
    expect(shortcutConflict(0x50, "deafen", current, new Set())).toBeNull();
  });
});
