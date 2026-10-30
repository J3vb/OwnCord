/**
 * Rebindable in-app actions: the action table, the persisted
 * `keybinds` preference, the one function capture and dispatch both use to
 * turn a keydown into a combo, and the conflict rules a rebind must pass.
 *
 * Mute and deafen keep their own prefs (`globalMuteVk` / `globalDeafenVk`, see
 * `voiceShortcuts.ts`) and are always Ctrl+Shift+key. They appear in the
 * effective set only so a rebind can be checked against them.
 *
 * `vk` is the same code `keyEventToVk` produces: the layout VK on Windows and
 * the physical key position elsewhere.
 */

import { loadPref, savePref } from "./preferences";
import {
  isBindableVk,
  keyEventToVk,
  loadGlobalShortcutVks,
  type GlobalShortcutVks,
} from "../voiceShortcuts";

export const KEYBINDS_PREF = "keybinds";
const KEYBINDS_VERSION = 1;

export interface KeyCombo {
  vk: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export type RebindableId =
  | "toggleCamera"
  | "toggleScreenshare"
  | "disconnect"
  | "search"
  | "uploadFile"
  | "emojiPicker"
  | "gifPicker";

export type ActionId = RebindableId | "toggleMute" | "toggleDeafen";

/** Every action's effective binding; null means unbound. */
export type EffectiveKeybinds = Readonly<Record<ActionId, KeyCombo | null>>;

export type KeybindScope = "global-capable" | "voice" | "app";

export type ConflictKind = "needsModifier" | "reserved" | "fixed" | "ptt" | "duplicate";

export interface KeybindConflict {
  kind: ConflictKind;
  /** The clashing action, for `duplicate`. */
  with?: ActionId;
}

const ctrlShift = (vk: number): KeyCombo => ({ vk, ctrl: true, shift: true, alt: false });
const ctrl = (vk: number): KeyCombo => ({ vk, ctrl: true, shift: false, alt: false });

const VK = {
  V: 0x56,
  U: 0x55,
  F: 0x46,
  E: 0x45,
  G: 0x47,
} as const;

/** Rebindable actions in table order, with their shipped defaults. */
export const REBINDABLE_ACTIONS: readonly {
  id: RebindableId;
  scope: KeybindScope;
  defaultCombo: KeyCombo | null;
}[] = [
  { id: "toggleCamera", scope: "voice", defaultCombo: ctrlShift(VK.V) },
  { id: "toggleScreenshare", scope: "voice", defaultCombo: null },
  { id: "disconnect", scope: "voice", defaultCombo: null },
  { id: "search", scope: "app", defaultCombo: ctrl(VK.F) },
  { id: "uploadFile", scope: "app", defaultCombo: ctrlShift(VK.U) },
  { id: "emojiPicker", scope: "app", defaultCombo: ctrl(VK.E) },
  { id: "gifPicker", scope: "app", defaultCombo: ctrl(VK.G) },
];

const REBINDABLE_IDS: ReadonlySet<string> = new Set(REBINDABLE_ACTIONS.map((a) => a.id));

/** Every action id, mute and deafen first. */
export const ACTION_IDS: readonly ActionId[] = [
  "toggleMute",
  "toggleDeafen",
  ...REBINDABLE_ACTIONS.map((a) => a.id),
];

/** A stable string for a combo, for equality and map keys. */
export function comboKey(combo: KeyCombo): string {
  return `${combo.ctrl ? "ctrl+" : ""}${combo.shift ? "shift+" : ""}${combo.alt ? "alt+" : ""}${combo.vk}`;
}

/** Which key identity a combo uses. */
export type ComboScope = "inApp" | "global";

/**
 * The VK of a single ASCII letter or digit `e.key` (the layout key), or null.
 * A letter is its uppercase code and a digit its own code, which are the VKs.
 */
function layoutVk(e: KeyboardEvent): number | null {
  if (typeof e.key !== "string" || !/^[a-zA-Z0-9]$/.test(e.key)) return null;
  return e.key.toUpperCase().charCodeAt(0);
}

/**
 * The combo a keydown represents, or null when it cannot be bound. Capture and
 * dispatch both go through this so they can never disagree. Win/Super is never
 * captured, and Ctrl+Alt is how Windows reports AltGr, so it would eat a typed
 * character on layouts that use it.
 *
 * Key identity: an in-app-only action ("inApp") stores and matches the layout
 * key, the VK of `e.key.toUpperCase()` when that is a single ASCII A-Z or 0-9
 * (so Colemak and Dvorak keep today's `e.key` matching); anything else uses
 * `keyEventToVk`. Global mute and deafen ("global") keep the physical
 * `keyEventToVk`, so they agree with the X11 poller. Cross-set checks (an
 * in-app combo against mute or deafen) compare the VKs as stored; a mismatch
 * between the two identities on non-QWERTY Linux layouts is accepted.
 */
export function comboFromEvent(e: KeyboardEvent, scope: ComboScope): KeyCombo | null {
  if (e.metaKey) return null;
  if (e.ctrlKey && e.altKey) return null;
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return null;
  const physical = keyEventToVk(e);
  if (physical === null) return null;
  const vk = (scope === "inApp" ? layoutVk(e) : null) ?? physical;
  return { vk, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}

// ---------------------------------------------------------------------------
// Conflict rules
// ---------------------------------------------------------------------------

const VK_R = 0x52;
const VK_P = 0x50;
const VK_I = 0x49;
const VK_J = 0x4a;
const VK_F4 = 0x73;
const VK_F5 = 0x74;
const VK_F11 = 0x7a;
const VK_F12 = 0x7b;
const VK_SPACE = 0x20;
const VK_HOME = 0x24;
const VK_END = 0x23;
const VK_INSERT = 0x2d;
const VK_DELETE = 0x2e;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_DOWN = 0x28;
const VK_F1 = 0x70;

const isFKey = (vk: number): boolean => vk >= VK_F1 && vk <= VK_F12;
const isArrow = (vk: number): boolean => vk >= VK_LEFT && vk <= VK_DOWN;
const TEXT_EDIT_VKS: ReadonlySet<number> = new Set([0x41, 0x43, 0x56, 0x58, 0x5a, 0x59]); // A C V X Z Y

/** Keys the OS, the webview or the text field itself keep. */
function isReserved(c: KeyCombo): boolean {
  // AltGr: see comboFromEvent.
  if (c.ctrl && c.alt) return true;
  if (c.alt && (c.vk === VK_F4 || c.vk === VK_SPACE)) return true;
  if (!c.alt && (c.vk === VK_F5 || c.vk === VK_F11 || c.vk === VK_F12)) return true;
  if (c.shift && !c.ctrl && !c.alt && c.vk === 0x79) return true; // Shift+F10 context menu
  if (c.ctrl && !c.alt && c.vk === VK_R) return true;
  if (c.ctrl && c.shift && (c.vk === VK_I || c.vk === VK_J)) return true;
  if (c.ctrl && !c.shift && c.vk === VK_P) return true;
  // Text editing. (Shift+arrow selects text but never gets here: needsModifier
  // refuses a Shift-only non-F key first.)
  if (c.ctrl && !c.shift && TEXT_EDIT_VKS.has(c.vk)) return true;
  if (c.ctrl && c.shift && c.vk === 0x5a) return true; // redo
  if (
    c.ctrl &&
    !c.alt &&
    (isArrow(c.vk) ||
      c.vk === VK_HOME ||
      c.vk === VK_END ||
      c.vk === VK_INSERT ||
      c.vk === VK_DELETE)
  )
    return true;
  return false;
}

/** App keys that stay fixed. Bare keys (Escape, PageUp/Down, the composer's
 *  arrow) never reach this table: `needsModifier` refuses them first. */
const FIXED_COMBO_KEYS: ReadonlySet<string> = new Set([
  comboKey(ctrl(0x4b)), // Ctrl+K quick switcher
  comboKey(ctrlShift(0x4b)), // the quick switcher matches any Shift state
  comboKey(ctrl(0x30)), // zoom reset (features/zoom/zoomKeys.ts)
  comboKey(ctrlShift(0x30)),
  comboKey(ctrl(0x42)), // composer bold
  comboKey(ctrl(0x49)), // composer italic
  comboKey(ctrl(0x55)), // composer underline
  comboKey(ctrl(0x4d)), // Ctrl+M alias of mute
  comboKey(ctrl(0x44)), // Ctrl+D alias of deafen
  comboKey(ctrl(0xbc)), // Ctrl+, opens Settings
  comboKey(ctrl(0xbf)), // Ctrl+/ shortcuts overlay
  comboKey(ctrl(0x0d)), // Ctrl+Enter accepts a ringing call
  ...[VK_UP, VK_DOWN].flatMap((vk) => [
    comboKey({ vk, ctrl: false, shift: false, alt: true }),
    comboKey({ vk, ctrl: false, shift: true, alt: true }),
  ]),
]);

/**
 * Why `combo` cannot be bound to `action`, or null when it is free. Checks run
 * in a fixed order: needsModifier, reserved, fixed, ptt, duplicate.
 * `effective` must include mute and deafen; `pttVk` is 0 when unset.
 */
export function keybindConflict(
  combo: KeyCombo,
  action: ActionId,
  effective: EffectiveKeybinds,
  pttVk: number,
): KeybindConflict | null {
  if (!combo.ctrl && !combo.alt && !isFKey(combo.vk)) return { kind: "needsModifier" };
  if (isReserved(combo)) return { kind: "reserved" };
  if (FIXED_COMBO_KEYS.has(comboKey(combo))) return { kind: "fixed" };
  // The poller ignores modifiers, so push to talk owns its key in any combo.
  if (pttVk !== 0 && combo.vk === pttVk) return { kind: "ptt" };
  const key = comboKey(combo);
  for (const id of ACTION_IDS) {
    if (id === action) continue;
    const other = effective[id];
    if (other !== null && comboKey(other) === key) return { kind: "duplicate", with: id };
  }
  return null;
}

/**
 * The VK of every in-app binding that is exactly Ctrl+Shift+key, mute and
 * deafen excluded. This is what a global mute/deafen binding may not claim
 * (`shortcutConflict`'s fourth argument).
 */
export function inAppCtrlShiftVks(effective: EffectiveKeybinds): Set<number> {
  const vks = new Set<number>();
  for (const { id } of REBINDABLE_ACTIONS) {
    const c = effective[id];
    if (c !== null && c.ctrl && c.shift && !c.alt) vks.add(c.vk);
  }
  return vks;
}

/**
 * Every VK a global mute/deafen binding (always Ctrl+Shift+key) may not claim:
 * the in-app Ctrl+Shift bindings plus the fixed app keys and the keys the OS
 * or a text field keep. Another handler acts on those too, so one press would
 * fire two actions.
 */
export function globalShortcutTakenVks(effective: EffectiveKeybinds): Set<number> {
  const vks = inAppCtrlShiftVks(effective);
  for (let vk = 0; vk <= 0xff; vk++) {
    if (!isBindableVk(vk)) continue;
    const combo = ctrlShift(vk);
    if (isReserved(combo) || FIXED_COMBO_KEYS.has(comboKey(combo))) vks.add(vk);
  }
  return vks;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type StoredBindings = Partial<Record<RebindableId, KeyCombo | null>>;

function isCombo(v: unknown): v is KeyCombo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.vk === "number" &&
    Number.isInteger(o.vk) &&
    typeof o.ctrl === "boolean" &&
    typeof o.shift === "boolean" &&
    typeof o.alt === "boolean" &&
    isBindableVk(o.vk)
  );
}

/** Entries that are the right shape and a bindable key; conflicts not checked. */
function readShapeValid(raw: unknown): StoredBindings {
  const out: StoredBindings = {};
  if (typeof raw !== "object" || raw === null) return out;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== KEYBINDS_VERSION) return out;
  const bindings = rec.bindings;
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return out;
  for (const [id, value] of Object.entries(bindings)) {
    if (!REBINDABLE_IDS.has(id)) continue;
    if (value === null) out[id as RebindableId] = null;
    else if (isCombo(value)) {
      out[id as RebindableId] = {
        vk: value.vk,
        ctrl: value.ctrl,
        shift: value.shift,
        alt: value.alt,
      };
    }
  }
  return out;
}

function defaults(globals: GlobalShortcutVks): Record<ActionId, KeyCombo | null> {
  const eff = {
    toggleMute: ctrlShift(globals.mute),
    toggleDeafen: ctrlShift(globals.deafen),
  } as Record<ActionId, KeyCombo | null>;
  for (const a of REBINDABLE_ACTIONS) eff[a.id] = a.defaultCombo;
  return eff;
}

/**
 * Validate a stored `keybinds` value into the effective set. Bad entries are
 * dropped one at a time, back to that action's default: a wrong type, a key
 * that cannot be bound, or a combo that now conflicts. `null` means unbound.
 */
export function parseKeybinds(
  raw: unknown,
  globals: GlobalShortcutVks = loadGlobalShortcutVks(),
  pttVk = loadPref<number>("pttVk", 0),
): EffectiveKeybinds {
  const stored = readShapeValid(raw);
  const eff = defaults(globals);
  for (const a of REBINDABLE_ACTIONS) {
    const v = stored[a.id];
    if (v !== undefined) eff[a.id] = v;
  }
  // Fixpoint: a conflicting override reverts to its default, and a reverted
  // default that still conflicts becomes null. Each action moves at most twice
  // (override -> default -> null), so this terminates, and the result never has
  // two rebindable actions on one combo.
  const level = new Map<RebindableId, 0 | 1 | 2>();
  for (const a of REBINDABLE_ACTIONS) {
    const v = stored[a.id];
    if (v !== undefined && v !== null) level.set(a.id, 0);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of REBINDABLE_ACTIONS) {
      const lv = level.get(a.id);
      const cur = eff[a.id];
      if (lv === undefined || lv === 2 || cur === null) continue;
      if (keybindConflict(cur, a.id, eff, pttVk) === null) continue;
      if (lv === 0) {
        eff[a.id] = a.defaultCombo;
        level.set(a.id, 1);
      } else {
        eff[a.id] = null;
        level.set(a.id, 2);
      }
      changed = true;
    }
  }
  return eff;
}

/** The effective binding for every action, from the persisted preference. */
export function loadEffectiveKeybinds(): EffectiveKeybinds {
  return parseKeybinds(
    loadPref<unknown>(KEYBINDS_PREF, {}),
    loadGlobalShortcutVks(),
    loadPref<number>("pttVk", 0),
  );
}

/**
 * Persist one action's binding: a combo, null to unbind, or undefined to reset
 * it to the default. The caller checks `keybindConflict` first. Other stored
 * entries are kept.
 */
export function saveKeybind(id: RebindableId, combo: KeyCombo | null | undefined): void {
  const bindings = readShapeValid(loadPref<unknown>(KEYBINDS_PREF, {}));
  if (combo === undefined) delete bindings[id];
  else bindings[id] = combo;
  savePref(KEYBINDS_PREF, { v: KEYBINDS_VERSION, bindings });
}
