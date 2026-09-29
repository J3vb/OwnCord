/**
 * Global voice shortcut bindings (U6 rebinding): the persisted per-action key
 * for the unfocused mute/deafen shortcuts, the focused-webview key capture the
 * Settings control uses, and the conflict rule it rejects.
 *
 * Key codes are Windows Virtual Key (VK) values on every platform, the same
 * convention `lib/ptt.ts` uses, and must stay within the range `shortcuts.rs`
 * can poll (`ptt.rs`'s VK/keycode table). Capture must name the key the
 * poller watches: on Windows `GetAsyncKeyState` reads the layout-mapped VK,
 * which WebView2 reports as `KeyboardEvent.keyCode`; on X11 `device_query`
 * keycodes are US physical positions, which `KeyboardEvent.code` names.
 */

import { loadPref, savePref } from "./preferences";

export type GlobalShortcutAction = "mute" | "deafen";

/** Preference keys, one per action. */
export const GLOBAL_MUTE_VK_PREF = "globalMuteVk";
export const GLOBAL_DEAFEN_VK_PREF = "globalDeafenVk";

/** Shipped defaults: Ctrl+Shift+M / Ctrl+Shift+D. */
export const DEFAULT_GLOBAL_MUTE_VK = 0x4d; // M
export const DEFAULT_GLOBAL_DEAFEN_VK = 0x44; // D

/** The in-app camera shortcut (Ctrl+Shift+V); a global binding may not claim it. */
const RESERVED_CAMERA_VK = 0x56; // V

export interface GlobalShortcutVks {
  mute: number;
  deafen: number;
}

const PREF_BY_ACTION: Readonly<Record<GlobalShortcutAction, string>> = {
  mute: GLOBAL_MUTE_VK_PREF,
  deafen: GLOBAL_DEAFEN_VK_PREF,
};

const DEFAULT_BY_ACTION: Readonly<Record<GlobalShortcutAction, number>> = {
  mute: DEFAULT_GLOBAL_MUTE_VK,
  deafen: DEFAULT_GLOBAL_DEAFEN_VK,
};

/** The persisted binding for both actions, falling back to the shipped defaults. */
export function loadGlobalShortcutVks(): GlobalShortcutVks {
  return {
    mute: loadPref<number>(PREF_BY_ACTION.mute, DEFAULT_BY_ACTION.mute),
    deafen: loadPref<number>(PREF_BY_ACTION.deafen, DEFAULT_BY_ACTION.deafen),
  };
}

/** Persist one action's binding. */
export function saveGlobalShortcutVk(action: GlobalShortcutAction, vk: number): void {
  savePref(PREF_BY_ACTION[action], vk);
}

/** Physical-key VK codes for the keys a global shortcut may bind: letters,
 *  digits, function keys and non-text navigation keys. Modifiers, Escape,
 *  Tab, Enter, Backspace, numpad and punctuation are deliberately absent —
 *  the combo already supplies the modifiers, Escape and Tab stay the capture's
 *  cancel and focus keys (as in `ptt.rs`'s capture), and Windows reports a
 *  Shift+numpad key as a navigation VK without Shift, so it could never fire. */
const VK_BY_CODE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (let i = 0; i < 26; i++) map.set(`Key${String.fromCharCode(0x41 + i)}`, 0x41 + i);
  for (let i = 0; i < 10; i++) map.set(`Digit${i}`, 0x30 + i);
  for (let i = 1; i <= 12; i++) map.set(`F${i}`, 0x6f + i);
  map.set("Space", 0x20);
  map.set("PageUp", 0x21);
  map.set("PageDown", 0x22);
  map.set("End", 0x23);
  map.set("Home", 0x24);
  map.set("ArrowLeft", 0x25);
  map.set("ArrowUp", 0x26);
  map.set("ArrowRight", 0x27);
  map.set("ArrowDown", 0x28);
  map.set("Insert", 0x2d);
  map.set("Delete", 0x2e);
  return map;
})();

const BINDABLE_VKS: ReadonlySet<number> = new Set(VK_BY_CODE.values());

/** The VK for a captured keydown, or null when the key is not bindable. */
export function keyEventToVk(event: KeyboardEvent): number | null {
  if (event.code.startsWith("Numpad")) return null;
  const vk = /Windows/.test(navigator.userAgent) ? event.keyCode : VK_BY_CODE.get(event.code);
  return vk !== undefined && BINDABLE_VKS.has(vk) ? vk : null;
}

/** Why `vk` cannot be bound to `action`, or null when it is free. */
export function shortcutConflict(
  vk: number,
  action: GlobalShortcutAction,
  current: GlobalShortcutVks,
): "duplicate" | "reserved" | null {
  const other = action === "mute" ? current.deafen : current.mute;
  if (vk === other) return "duplicate";
  if (vk === RESERVED_CAMERA_VK) return "reserved";
  return null;
}
