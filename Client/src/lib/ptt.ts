import { voiceText } from "../i18n/voice";

/**
 * Push-to-Talk display helpers. The PTT service itself — Rust-side
 * GetAsyncKeyState polling, so the key is NOT consumed/hijacked — is
 * `platform/desktop/pushToTalk.ts` (B7-5); callers reach it through the
 * desktop registry's `pushToTalk`.
 */

// Well-known virtual key code names for display
// i18n-exempt: F1-F16 and punctuation key labels have no English words; the named
// keys above resolve through the voice catalog.
const VK_NAMES: ReadonlyMap<number, string> = new Map([
  [0x01, voiceText("key.mouseLeft")],
  [0x02, voiceText("key.mouseRight")],
  [0x04, voiceText("key.mouseMiddle")],
  [0x05, voiceText("key.mouse4")],
  [0x06, voiceText("key.mouse5")],
  [0x08, voiceText("key.backspace")],
  [0x09, voiceText("key.tab")],
  [0x0d, voiceText("key.enter")],
  [0x1b, voiceText("key.escape")],
  [0x20, voiceText("key.space")],
  [0x21, voiceText("key.pageUp")],
  [0x22, voiceText("key.pageDown")],
  [0x23, voiceText("key.end")],
  [0x24, voiceText("key.home")],
  [0x25, voiceText("key.arrowLeft")],
  [0x26, voiceText("key.arrowUp")],
  [0x27, voiceText("key.arrowRight")],
  [0x28, voiceText("key.arrowDown")],
  [0x2d, voiceText("key.insert")],
  [0x2e, voiceText("key.delete")],
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
  if (VK_NAMES.has(vk)) return VK_NAMES.get(vk)!;
  // 0-9 keys
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  // A-Z keys
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  // Numpad 0-9
  if (vk >= 0x60 && vk <= 0x69) return voiceText("key.numpad", { digit: vk - 0x60 });
  return voiceText("key.unknown", { code: vk.toString(16).toUpperCase() });
}
