import { voiceText } from "../i18n/voice";

/**
 * Push-to-Talk display helpers. The PTT service itself — Rust-side
 * GetAsyncKeyState polling, so the key is NOT consumed/hijacked — is
 * `platform/desktop/pushToTalk.ts` (B7-5); callers reach it through the
 * desktop registry's `pushToTalk`.
 */

// Well-known virtual key code names for display, resolved when rendered
const NAMED_KEYS = [
  [0x01, "key.mouseLeft"],
  [0x02, "key.mouseRight"],
  [0x04, "key.mouseMiddle"],
  [0x05, "key.mouse4"],
  [0x06, "key.mouse5"],
  [0x08, "key.backspace"],
  [0x09, "key.tab"],
  [0x0d, "key.enter"],
  [0x1b, "key.escape"],
  [0x20, "key.space"],
  [0x21, "key.pageUp"],
  [0x22, "key.pageDown"],
  [0x23, "key.end"],
  [0x24, "key.home"],
  [0x25, "key.arrowLeft"],
  [0x26, "key.arrowUp"],
  [0x27, "key.arrowRight"],
  [0x28, "key.arrowDown"],
  [0x2d, "key.insert"],
  [0x2e, "key.delete"],
] as const;
const VK_KEYS: ReadonlyMap<number, (typeof NAMED_KEYS)[number][1]> = new Map(NAMED_KEYS);

// i18n-exempt: F1-F16 and punctuation key labels have no English words; the named
// keys above resolve through the voice catalog.
const VK_SYMBOLS: ReadonlyMap<number, string> = new Map([
  [0x70, "F1"],
  [0x71, "F2"],
  [0x72, "F3"],
  [0x73, "F4"],
  [0x74, "F5"],
  [0x75, "F6"],
  [0x76, "F7"],
  [0x77, "F8"],
  [0x78, "F9"],
  [0x79, "F10"],
  [0x7a, "F11"],
  [0x7b, "F12"],
  [0x7c, "F13"],
  [0x7d, "F14"],
  [0x7e, "F15"],
  [0x7f, "F16"],
  [0xc0, "`"],
  [0xbd, "-"],
  [0xbb, "="],
  [0xdb, "["],
  [0xdd, "]"],
  [0xdc, "\\"],
  [0xba, ";"],
  [0xde, "'"],
  [0xbc, ","],
  [0xbe, "."],
  [0xbf, "/"],
]);

/** Get a human-readable name for a virtual key code. */
export function vkName(vk: number): string {
  const key = VK_KEYS.get(vk);
  if (key !== undefined) return voiceText(key);
  const symbol = VK_SYMBOLS.get(vk);
  if (symbol !== undefined) return symbol;
  // 0-9 keys
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  // A-Z keys
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  // Numpad 0-9
  if (vk >= 0x60 && vk <= 0x69) return voiceText("key.numpad", { digit: vk - 0x60 });
  return voiceText("key.unknown", { code: vk.toString(16).toUpperCase() });
}
