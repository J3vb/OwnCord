// WP 3E-3c step 1: the rebindable-action model — defaults, the persisted
// `keybinds` pref, the shared event-to-combo function and the conflict rules.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ACTION_IDS,
  KEYBINDS_PREF,
  REBINDABLE_ACTIONS,
  comboFromEvent,
  comboKey,
  globalShortcutTakenVks,
  inAppCtrlShiftVks,
  keybindConflict,
  loadEffectiveKeybinds,
  parseKeybinds,
  saveKeybind,
  type KeyCombo,
} from "../../src/lib/prefs/keybinds";
import { isBindableVk, saveGlobalShortcutVk } from "../../src/lib/voice/voiceShortcuts";
import { STORAGE_PREFIX } from "../../src/lib/prefs/preferences";

const GLOBALS = { mute: 0x4d, deafen: 0x44 };
const c = (vk: number, mods: Partial<Omit<KeyCombo, "vk">> = {}): KeyCombo => ({
  vk,
  ctrl: false,
  shift: false,
  alt: false,
  ...mods,
});
const stored = (bindings: Record<string, unknown>): unknown => ({ v: 1, bindings });
const defaults = parseKeybinds(undefined, GLOBALS);

function ev(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, ...init });
}

describe("defaults", () => {
  it("reproduces today's fixed keys", () => {
    expect(defaults.toggleCamera).toEqual(c(0x56, { ctrl: true, shift: true }));
    expect(defaults.uploadFile).toEqual(c(0x55, { ctrl: true, shift: true }));
    expect(defaults.search).toEqual(c(0x46, { ctrl: true }));
    expect(defaults.emojiPicker).toEqual(c(0x45, { ctrl: true }));
    expect(defaults.gifPicker).toEqual(c(0x47, { ctrl: true }));
    expect(defaults.toggleMute).toEqual(c(0x4d, { ctrl: true, shift: true }));
    expect(defaults.toggleDeafen).toEqual(c(0x44, { ctrl: true, shift: true }));
  });

  it("leaves screen share and disconnect unbound", () => {
    expect(defaults.toggleScreenshare).toBeNull();
    expect(defaults.disconnect).toBeNull();
  });

  it("passes its own conflict rules, with every action distinct", () => {
    for (const id of ACTION_IDS) {
      const combo = defaults[id];
      if (combo !== null) expect(keybindConflict(combo, id, defaults, 0)).toBeNull();
    }
    expect(REBINDABLE_ACTIONS).toHaveLength(7);
  });

  it("follows the mute and deafen prefs", () => {
    const eff = parseKeybinds(undefined, { mute: 0x4b, deafen: 0x71 });
    expect(eff.toggleMute).toEqual(c(0x4b, { ctrl: true, shift: true }));
    expect(eff.toggleDeafen).toEqual(c(0x71, { ctrl: true, shift: true }));
  });
});

describe("parseKeybinds", () => {
  it("applies a valid override and keeps the rest at default", () => {
    const eff = parseKeybinds(
      stored({ toggleCamera: c(0x58, { ctrl: true, shift: true }) }),
      GLOBALS,
    );
    expect(eff.toggleCamera).toEqual(c(0x58, { ctrl: true, shift: true }));
    expect(eff.search).toEqual(defaults.search);
  });

  it("treats null as unbound, even for an action with a default", () => {
    const eff = parseKeybinds(stored({ search: null, disconnect: null }), GLOBALS);
    expect(eff.search).toBeNull();
    expect(eff.disconnect).toBeNull();
  });

  it("drops bad entries one at a time", () => {
    const eff = parseKeybinds(
      stored({
        toggleCamera: { vk: "x", ctrl: true, shift: false, alt: false }, // wrong type
        search: c(0x1b, { ctrl: true }), // Escape cannot be bound
        uploadFile: c(0x4b, { ctrl: true }), // Ctrl+K is fixed
        toggleScreenshare: c(0x51, { ctrl: true }), // valid
        emojiPicker: c(0x4d, { ctrl: true, shift: true }), // collides with mute
        bogus: c(0x51, { ctrl: true }), // unknown action
        gifPicker: "nope",
      }),
      GLOBALS,
    );
    expect(eff.toggleCamera).toEqual(defaults.toggleCamera);
    expect(eff.search).toEqual(defaults.search);
    expect(eff.uploadFile).toEqual(defaults.uploadFile);
    expect(eff.emojiPicker).toEqual(defaults.emojiPicker);
    expect(eff.gifPicker).toEqual(defaults.gifPicker);
    expect(eff.toggleScreenshare).toEqual(c(0x51, { ctrl: true }));
    expect(Object.keys(eff)).not.toContain("bogus");
  });

  it("drops a combo that now collides with a mute key moved onto it (cross-store)", () => {
    const eff = parseKeybinds(stored({ toggleCamera: c(0x58, { ctrl: true, shift: true }) }), {
      mute: 0x58,
      deafen: 0x44,
    });
    expect(eff.toggleCamera).toEqual(defaults.toggleCamera);
  });

  it("drops a combo equal to the push-to-talk F key", () => {
    const raw = stored({ toggleScreenshare: c(0x74 + 1) }); // F6, bare
    expect(parseKeybinds(raw, GLOBALS, 0).toggleScreenshare).toEqual(c(0x75));
    expect(parseKeybinds(raw, GLOBALS, 0x75).toggleScreenshare).toBeNull();
  });

  it("accepts a swap of two defaults, since neither entry conflicts once both apply", () => {
    const eff = parseKeybinds(
      stored({
        search: c(0x55, { ctrl: true, shift: true }),
        uploadFile: c(0x46, { ctrl: true }),
      }),
      GLOBALS,
    );
    expect(eff.search).toEqual(c(0x55, { ctrl: true, shift: true }));
    expect(eff.uploadFile).toEqual(c(0x46, { ctrl: true }));
  });

  it.each([
    undefined,
    null,
    5,
    "x",
    [],
    {},
    { v: 2, bindings: {} },
    { v: 1 },
    { v: 1, bindings: [] },
  ])("falls back to defaults for malformed root %j", (raw) => {
    expect(parseKeybinds(raw, GLOBALS)).toEqual(defaults);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("loads defaults when nothing is stored", () => {
    expect(loadEffectiveKeybinds()).toEqual(defaults);
  });

  it("round-trips a binding, an unbind and a reset", () => {
    saveKeybind("toggleScreenshare", c(0x51, { ctrl: true }));
    saveKeybind("search", null);
    expect(loadEffectiveKeybinds().toggleScreenshare).toEqual(c(0x51, { ctrl: true }));
    expect(loadEffectiveKeybinds().search).toBeNull();
    saveKeybind("search", undefined);
    expect(loadEffectiveKeybinds().search).toEqual(defaults.search);
    expect(loadEffectiveKeybinds().toggleScreenshare).toEqual(c(0x51, { ctrl: true }));
    expect(JSON.parse(localStorage.getItem(STORAGE_PREFIX + KEYBINDS_PREF) ?? "")).toEqual({
      v: 1,
      bindings: { toggleScreenshare: c(0x51, { ctrl: true }) },
    });
  });

  it("notifies same-window listeners", () => {
    const seen: string[] = [];
    const on = (e: Event): void => {
      seen.push((e as CustomEvent<{ key: string }>).detail.key);
    };
    window.addEventListener("owncord:pref-change", on);
    saveKeybind("disconnect", c(0x51, { ctrl: true }));
    window.removeEventListener("owncord:pref-change", on);
    expect(seen).toEqual([KEYBINDS_PREF]);
  });

  it("does not lose a good entry when another stored one is corrupt", () => {
    localStorage.setItem(
      STORAGE_PREFIX + KEYBINDS_PREF,
      JSON.stringify(stored({ disconnect: c(0x51, { ctrl: true }), search: "junk" })),
    );
    saveKeybind("gifPicker", null);
    const eff = loadEffectiveKeybinds();
    expect(eff.disconnect).toEqual(c(0x51, { ctrl: true }));
    expect(eff.gifPicker).toBeNull();
    expect(eff.search).toEqual(defaults.search);
  });

  it("reads mute and deafen from their own prefs and the PTT key", () => {
    saveGlobalShortcutVk("mute", 0x58);
    localStorage.setItem(STORAGE_PREFIX + "pttVk", "118"); // F7
    saveKeybind("toggleCamera", c(0x58, { ctrl: true, shift: true }));
    saveKeybind("disconnect", c(0x76)); // F7 bare
    const eff = loadEffectiveKeybinds();
    expect(eff.toggleMute).toEqual(c(0x58, { ctrl: true, shift: true }));
    expect(eff.toggleCamera).toEqual(defaults.toggleCamera);
    expect(eff.disconnect).toBeNull();
  });
});

describe("comboKey", () => {
  it("is distinct per modifier set and key", () => {
    const keys = [
      comboKey(c(70, { ctrl: true })),
      comboKey(c(70, { shift: true })),
      comboKey(c(70, { alt: true })),
      comboKey(c(70, { ctrl: true, shift: true })),
      comboKey(c(71, { ctrl: true })),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("comboFromEvent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the key and modifiers", () => {
    expect(comboFromEvent(ev("KeyX", { ctrlKey: true, shiftKey: true }), "inApp")).toEqual(
      c(0x58, { ctrl: true, shift: true }),
    );
    expect(comboFromEvent(ev("F6", { altKey: true }), "inApp")).toEqual(c(0x75, { alt: true }));
  });

  it.each(["inApp", "global"] as const)("refuses Meta (%s)", (scope) => {
    expect(comboFromEvent(ev("KeyX", { ctrlKey: true, metaKey: true }), scope)).toBeNull();
  });

  it("refuses AltGr, however the platform reports it", () => {
    expect(comboFromEvent(ev("KeyQ", { ctrlKey: true, altKey: true }), "inApp")).toBeNull();
    const e = ev("KeyQ");
    vi.spyOn(e, "getModifierState").mockImplementation((k) => k === "AltGraph");
    expect(comboFromEvent(e, "inApp")).toBeNull();
  });

  it("refuses a modifier-only or unbindable key", () => {
    expect(comboFromEvent(ev("ShiftLeft", { shiftKey: true }), "inApp")).toBeNull();
    expect(comboFromEvent(ev("Escape"), "inApp")).toBeNull();
    expect(comboFromEvent(ev("Numpad1", { ctrlKey: true }), "inApp")).toBeNull();
  });

  it("on Linux, an in-app action takes the layout key and mute/deafen the physical one", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    // Dvorak: the key at US position F is labelled U.
    const e = ev("KeyF", { key: "u", ctrlKey: true, shiftKey: true });
    expect(comboFromEvent(e, "inApp")).toEqual(c(0x55, { ctrl: true, shift: true }));
    expect(comboFromEvent(e, "global")).toEqual(c(0x46, { ctrl: true, shift: true }));
  });

  it("falls back to the physical key when e.key is not a single ASCII letter or digit", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    expect(comboFromEvent(ev("KeyF", { key: "F", ctrlKey: true }), "inApp")?.vk).toBe(0x46);
    expect(comboFromEvent(ev("Digit1", { key: "!", ctrlKey: true }), "inApp")?.vk).toBe(0x31);
    expect(comboFromEvent(ev("KeyF", { key: "é", ctrlKey: true }), "inApp")?.vk).toBe(0x46);
    expect(comboFromEvent(ev("F6", { key: "F6", ctrlKey: true }), "inApp")?.vk).toBe(0x75);
    expect(comboFromEvent(ev("Digit7", { key: "7", ctrlKey: true }), "inApp")?.vk).toBe(0x37);
  });

  it("capture and dispatch events built differently still give one combo (Windows AZERTY)", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0) Edg/140",
    );
    // Capture: Shift held, so the browser reports the uppercase letter.
    const captured = comboFromEvent(
      ev("KeyQ", { key: "A", keyCode: 0x41, ctrlKey: true, shiftKey: true }),
      "inApp",
    );
    // Dispatch: a later keydown with the letter in lowercase from a different code path.
    const dispatched = comboFromEvent(
      ev("KeyQ", { key: "a", keyCode: 0x41, ctrlKey: true, shiftKey: true }),
      "inApp",
    );
    expect(captured).toEqual(c(0x41, { ctrl: true, shift: true }));
    expect(dispatched).not.toBeNull();
    expect(comboKey(dispatched as KeyCombo)).toBe(comboKey(captured as KeyCombo));
  });
});

describe("keybindConflict", () => {
  const check = (
    combo: KeyCombo,
    id: Parameters<typeof keybindConflict>[1] = "disconnect",
    ptt = 0,
  ) => keybindConflict(combo, id, defaults, ptt);

  it("needsModifier: a bare or Shift-only non-F key", () => {
    expect(check(c(0x58))).toEqual({ kind: "needsModifier" });
    expect(check(c(0x20, { shift: true }))).toEqual({ kind: "needsModifier" });
    expect(check(c(0x26))).toEqual({ kind: "needsModifier" });
  });

  it("allows a bare or Shift F key", () => {
    expect(check(c(0x75))).toBeNull();
    expect(check(c(0x75, { shift: true }))).toBeNull();
  });

  it("reserved: every Ctrl+Alt combo", () => {
    expect(check(c(0x51, { ctrl: true, alt: true }))).toEqual({ kind: "reserved" });
  });

  it.each([
    ["Alt+F4", c(0x73, { alt: true })],
    ["Alt+Space", c(0x20, { alt: true })],
    ["F5", c(0x74)],
    ["F11", c(0x7a)],
    ["F12", c(0x7b)],
    ["Shift+F10", c(0x79, { shift: true })],
    ["Ctrl+R", c(0x52, { ctrl: true })],
    ["Ctrl+Shift+R", c(0x52, { ctrl: true, shift: true })],
    ["Ctrl+Shift+I", c(0x49, { ctrl: true, shift: true })],
    ["Ctrl+Shift+J", c(0x4a, { ctrl: true, shift: true })],
    ["Ctrl+P", c(0x50, { ctrl: true })],
    ["Ctrl+A", c(0x41, { ctrl: true })],
    ["Ctrl+C", c(0x43, { ctrl: true })],
    ["Ctrl+V", c(0x56, { ctrl: true })],
    ["Ctrl+X", c(0x58, { ctrl: true })],
    ["Ctrl+Z", c(0x5a, { ctrl: true })],
    ["Ctrl+Y", c(0x59, { ctrl: true })],
    ["Ctrl+Shift+Z", c(0x5a, { ctrl: true, shift: true })],
    ["Ctrl+Left", c(0x25, { ctrl: true })],
    ["Ctrl+Shift+Home", c(0x24, { ctrl: true, shift: true })],
    ["Ctrl+End", c(0x23, { ctrl: true })],
  ])("reserved: %s", (_name, combo) => {
    expect(check(combo)).toEqual({ kind: "reserved" });
  });

  it("does not reserve Ctrl+Shift+V, which is camera's default", () => {
    expect(check(c(0x56, { ctrl: true, shift: true }), "toggleCamera")).toBeNull();
  });

  it.each([
    ["Ctrl+K", c(0x4b, { ctrl: true })],
    ["Ctrl+B", c(0x42, { ctrl: true })],
    ["Ctrl+I", c(0x49, { ctrl: true })],
    ["Ctrl+U", c(0x55, { ctrl: true })],
    ["Ctrl+M", c(0x4d, { ctrl: true })],
    ["Ctrl+D", c(0x44, { ctrl: true })],
    ["Ctrl+,", c(0xbc, { ctrl: true })],
    ["Ctrl+/", c(0xbf, { ctrl: true })],
    ["Ctrl+Enter", c(0x0d, { ctrl: true })],
    ["Alt+Up", c(0x26, { alt: true })],
    ["Alt+Down", c(0x28, { alt: true })],
    ["Alt+Shift+Up", c(0x26, { alt: true, shift: true })],
    ["Alt+Shift+Down", c(0x28, { alt: true, shift: true })],
  ])("fixed: %s", (_name, combo) => {
    expect(check(combo)).toEqual({ kind: "fixed" });
  });

  it("ptt: the push-to-talk key in any combo, since the poller ignores modifiers", () => {
    expect(check(c(0x75), "disconnect", 0x75)).toEqual({ kind: "ptt" });
    expect(check(c(0x75, { shift: true }), "disconnect", 0x75)).toEqual({ kind: "ptt" });
    expect(check(c(0x75), "disconnect", 0)).toBeNull();
  });

  it("duplicate: names the action it clashes with", () => {
    expect(check(c(0x46, { ctrl: true }), "toggleCamera")).toEqual({
      kind: "duplicate",
      with: "search",
    });
    expect(check(c(0x4d, { ctrl: true, shift: true }), "toggleCamera")).toEqual({
      kind: "duplicate",
      with: "toggleMute",
    });
    expect(check(c(0x44, { ctrl: true, shift: true }), "uploadFile")).toEqual({
      kind: "duplicate",
      with: "toggleDeafen",
    });
  });

  it("does not count an action against its own binding", () => {
    expect(check(c(0x46, { ctrl: true }), "search")).toBeNull();
  });

  it("checks in order: needsModifier > reserved > fixed > ptt > duplicate", () => {
    expect(check(c(0x41), "search", 0x41)).toEqual({ kind: "needsModifier" });
    expect(check(c(0x52, { ctrl: true }), "search", 0x52)).toEqual({ kind: "reserved" });
    expect(check(c(0x4b, { ctrl: true }), "search", 0x4b)).toEqual({ kind: "fixed" });
    expect(check(c(0x46, { ctrl: true }), "toggleCamera", 0x46)).toEqual({ kind: "ptt" });
    expect(check(c(0x46, { ctrl: true }), "toggleCamera", 0)).toEqual({
      kind: "duplicate",
      with: "search",
    });
  });

  it("fixed: Ctrl+Shift+K and the zoom reset keys", () => {
    expect(check(c(0x4b, { ctrl: true, shift: true }))).toEqual({ kind: "fixed" });
  });
  it("fixed: Ctrl+0", () => {
    expect(check(c(0x30, { ctrl: true }))).toEqual({ kind: "fixed" });
  });
  it("fixed: Ctrl+Shift+0", () => {
    expect(check(c(0x30, { ctrl: true, shift: true }))).toEqual({ kind: "fixed" });
  });
  it("reserved: Ctrl+Delete", () => {
    expect(check(c(0x2e, { ctrl: true }))).toEqual({ kind: "reserved" });
  });
  it("reserved: Ctrl+Insert", () => {
    expect(check(c(0x2d, { ctrl: true }))).toEqual({ kind: "reserved" });
  });

  it("ignores unbound actions when looking for duplicates", () => {
    const eff = { ...defaults, search: null };
    expect(keybindConflict(c(0x46, { ctrl: true }), "toggleCamera", eff, 0)).toBeNull();
  });
});

describe("inAppCtrlShiftVks", () => {
  it("is V and U by default, excluding mute and deafen", () => {
    expect(inAppCtrlShiftVks(defaults)).toEqual(new Set([0x56, 0x55]));
  });

  it("follows a rebind and skips non-Ctrl+Shift or unbound actions", () => {
    const eff = parseKeybinds(
      stored({
        toggleCamera: c(0x58, { ctrl: true, shift: true }),
        uploadFile: null,
        disconnect: c(0x59 + 1, { ctrl: true }),
      }),
      GLOBALS,
    );
    expect(inAppCtrlShiftVks(eff)).toEqual(new Set([0x58]));
  });
});

/** Checks `combo` for the default-less disconnect action against the shipped defaults. */
const conflictOf = (combo: KeyCombo, ptt = 0) =>
  keybindConflict(combo, "disconnect", defaults, ptt);

describe("keybindConflict around each reserved key", () => {
  it.each([
    ["F1 on its own", c(0x70)],
    ["F9 on its own", c(0x78)],
    ["F10 on its own", c(0x79)],
    ["Ctrl+F10", c(0x79, { ctrl: true })],
    ["Ctrl+Shift+F10", c(0x79, { ctrl: true, shift: true })],
    ["Alt+Shift+F10", c(0x79, { alt: true, shift: true })],
    ["Ctrl+Shift+F9", c(0x78, { ctrl: true, shift: true })],
    ["Alt+F5", c(0x74, { alt: true })],
    ["Alt+X", c(0x58, { alt: true })],
    ["Alt+P", c(0x50, { alt: true })],
    ["Alt+R", c(0x52, { alt: true })],
    ["Alt+Shift+Z", c(0x5a, { alt: true, shift: true })],
    ["Alt+Left", c(0x25, { alt: true })],
    ["Ctrl+Shift+P", c(0x50, { ctrl: true, shift: true })],
    ["Ctrl+Shift+A", c(0x41, { ctrl: true, shift: true })],
    ["Ctrl+Shift+Y", c(0x59, { ctrl: true, shift: true })],
    ["Ctrl+J", c(0x4a, { ctrl: true })],
  ])("leaves %s free", (_name, combo) => {
    expect(conflictOf(combo)).toBeNull();
  });

  it.each([
    ["Shift+F5", c(0x74, { shift: true })],
    ["Ctrl+F11", c(0x7a, { ctrl: true })],
    ["Ctrl+Shift+F12", c(0x7b, { ctrl: true, shift: true })],
    ["Ctrl+Up", c(0x26, { ctrl: true })],
    ["Ctrl+Right", c(0x27, { ctrl: true })],
    ["Ctrl+Down", c(0x28, { ctrl: true })],
    ["Ctrl+Home", c(0x24, { ctrl: true })],
    ["Ctrl+Shift+Delete", c(0x2e, { ctrl: true, shift: true })],
  ])("reserves %s", (_name, combo) => {
    expect(conflictOf(combo)).toEqual({ kind: "reserved" });
  });

  it("asks for a modifier on keys above F12", () => {
    expect(conflictOf(c(0x7c))).toEqual({ kind: "needsModifier" });
    expect(conflictOf(c(0x7c, { shift: true }))).toEqual({ kind: "needsModifier" });
  });

  it("does not let an unset push-to-talk key claim virtual key 0", () => {
    expect(conflictOf(c(0, { ctrl: true }), 0)).toBeNull();
    expect(conflictOf(c(0, { ctrl: true }), 0x58)).toBeNull();
  });
});

describe("globalShortcutTakenVks", () => {
  it("never names a key that cannot be bound", () => {
    const taken = globalShortcutTakenVks(defaults);
    for (let vk = 0; vk <= 0xff; vk++) {
      if (!isBindableVk(vk)) expect(taken.has(vk)).toBe(false);
    }
    expect(taken.has(0x4b)).toBe(true); // Ctrl+Shift+K, the quick switcher
    expect(taken.has(0x56)).toBe(true); // Ctrl+Shift+V, camera
  });
});

/** A bare keydown-shaped object, the way a synthetic or test-bridge event looks. */
function plain(init: Record<string, unknown>): KeyboardEvent {
  return {
    code: "KeyA",
    key: "a",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  } as unknown as KeyboardEvent;
}

describe("comboFromEvent with events from other sources", () => {
  it("reads an event that cannot report modifier state", () => {
    expect(comboFromEvent(plain({}), "inApp")).toEqual(c(0x41, { ctrl: true }));
  });

  it("takes the physical key when the event's key is not text at all", () => {
    expect(comboFromEvent(plain({ key: 5 }), "inApp")).toEqual(c(0x41, { ctrl: true }));
    expect(comboFromEvent(plain({ key: { toString: () => "q" } }), "inApp")).toEqual(
      c(0x41, { ctrl: true }),
    );
    expect(comboFromEvent(plain({ key: undefined }), "inApp")).toEqual(c(0x41, { ctrl: true }));
  });

  it("takes the physical key for a named key such as Enter", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    expect(comboFromEvent(ev("Space", { key: "Enter", ctrlKey: true }), "inApp")?.vk).toBe(0x20);
    vi.restoreAllMocks();
  });
});

describe("stored keybind shapes", () => {
  it.each([
    ["ctrl", { vk: 0x51, ctrl: "yes", shift: false, alt: false }],
    ["shift", { vk: 0x51, ctrl: true, shift: 1, alt: false }],
    ["alt", { vk: 0x51, ctrl: false, shift: false, alt: "yes" }],
  ])("drops a combo whose %s flag is not a boolean", (_flag, combo) => {
    const eff = parseKeybinds(stored({ toggleScreenshare: combo }), GLOBALS);
    expect(eff.toggleScreenshare).toBeNull();
  });

  it("ignores a stored list written by another version", () => {
    const raw = { v: 2, bindings: { search: c(0x51, { ctrl: true }) } };
    expect(parseKeybinds(raw, GLOBALS).search).toEqual(defaults.search);
  });

  it("does not carry unknown actions or non-combo values forward when another binding is saved", () => {
    localStorage.setItem(
      STORAGE_PREFIX + KEYBINDS_PREF,
      JSON.stringify(
        stored({
          bogus: c(0x51, { ctrl: true }),
          toggleMute: c(0x51, { ctrl: true }),
          search: "junk",
          gifPicker: 7,
          disconnect: c(0x52, { alt: true }),
        }),
      ),
    );
    saveKeybind("uploadFile", null);
    expect(JSON.parse(localStorage.getItem(STORAGE_PREFIX + KEYBINDS_PREF) ?? "")).toEqual({
      v: 1,
      bindings: { disconnect: c(0x52, { alt: true }), uploadFile: null },
    });
  });
});

describe("keybinds reverting to defaults", () => {
  afterEach(() => localStorage.clear());

  it("reads the push-to-talk key from its preference when none is passed", () => {
    localStorage.setItem(STORAGE_PREFIX + "pttVk", String(0x4a)); // J
    const raw = stored({ emojiPicker: c(0x4a, { ctrl: true }) });
    expect(parseKeybinds(raw, GLOBALS).emojiPicker).toEqual(defaults.emojiPicker);
    localStorage.setItem(STORAGE_PREFIX + "pttVk", "0");
    expect(parseKeybinds(raw, GLOBALS).emojiPicker).toEqual(c(0x4a, { ctrl: true }));
  });

  it("leaves a shipped default alone even when push-to-talk shares its key", () => {
    const eff = parseKeybinds(undefined, GLOBALS, 0x46); // F, Ctrl+F is search
    expect(eff.search).toEqual(defaults.search);
    expect(eff.toggleCamera).toEqual(defaults.toggleCamera);
  });

  it("unbinds an action whose override and whose default both clash", () => {
    // Deafen sits on Ctrl+Shift+V, camera's default; the override clashes with mute.
    const globals = { mute: 0x4d, deafen: 0x56 };
    const raw = stored({ toggleCamera: c(0x4d, { ctrl: true, shift: true }) });
    const eff = parseKeybinds(raw, globals);
    expect(eff.toggleCamera).toBeNull();
    expect(eff.toggleMute).toEqual(c(0x4d, { ctrl: true, shift: true }));
    expect(eff.search).toEqual(defaults.search);
  });

  it("settles a chain of reverts: a default freed by one revert is taken by the next", () => {
    const raw = stored({
      toggleCamera: c(0x4d, { ctrl: true, shift: true }), // clashes with mute
      gifPicker: c(0x56, { ctrl: true, shift: true }), // camera's default
    });
    const eff = parseKeybinds(raw, GLOBALS);
    expect(eff.toggleCamera).toEqual(defaults.toggleCamera);
    expect(eff.gifPicker).toEqual(defaults.gifPicker);
  });
});
