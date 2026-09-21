/**
 * Push-to-Talk display helpers. The PTT service itself — Rust-side
 * GetAsyncKeyState polling, so the key is NOT consumed/hijacked — is
 * `platform/desktop/pushToTalk.ts` (B7-5); callers reach it through the
 * desktop registry's `pushToTalk`.
 */

// Well-known virtual key code names for display
const VK_NAMES: ReadonlyMap<number, string> = new Map([
  [0x01, "Mouse Left"],
  [0x02, "Mouse Right"],
  [0x04, "Mouse Middle"],
  [0x05, "Mouse 4"],
  [0x06, "Mouse 5"],
  [0x08, "Backspace"],
  [0x09, "Tab"],
  [0x0d, "Enter"],
  [0x1b, "Escape"],
  [0x20, "Space"],
  [0x21, "Page Up"],
  [0x22, "Page Down"],
  [0x23, "End"],
  [0x24, "Home"],
  [0x25, "Arrow Left"],
  [0x26, "Arrow Up"],
  [0x27, "Arrow Right"],
  [0x28, "Arrow Down"],
  [0x2d, "Insert"],
  [0x2e, "Delete"],
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
  if (vk >= 0x60 && vk <= 0x69) return `Numpad ${vk - 0x60}`;
  return `Key 0x${vk.toString(16).toUpperCase()}`;
}
