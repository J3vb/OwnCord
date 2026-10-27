/**
 * Peer identity pins as a set (encryption key per device).
 *
 * One account can be signed in on several devices, each with its own identity
 * keypair, so a peer is trusted for every key seen for them (TOFU per key), not
 * for one. The pin store holds ONE string per `{host}:{userId}`; this module
 * defines what that string means:
 *
 *   - a single key is stored as the bare base64 key, exactly what older clients
 *     wrote. A legacy pin therefore reads as a set of one with no migration
 *     step, and is only rewritten once a second key is added;
 *   - two or more keys are stored joined with `_`, oldest first. Identity keys
 *     are standard base64 (`+`, `/`, `=`, no `_`), so `_` never occurs inside a
 *     key and the split is unambiguous.
 *
 * The desktop pin store (`store_identity_pin` in `src-tauri/src/commands.rs`)
 * accepts 1-512 characters of `[A-Za-z0-9+/=_-]` and nothing else, so the set
 * is encoded in that alphabet and capped to fit: a raw P-256 key is 88 base64
 * characters, so 5 keys joined by 4 separators are 444 characters (<= 512),
 * while 6 would be 533. That is why the cap is 5.
 */

/** Most keys kept per peer. Adding one more drops the oldest.
 *  5 x 88 + 4 separators = 444 characters, within the desktop store's 512. */
export const MAX_PINS_PER_USER = 5;

/** Separator between keys in a multi-key slot. Not part of standard base64. */
const PIN_SEPARATOR = "_";

/** Standard base64 (with padding), the alphabet identity keys use. */
const STD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Keys trusted for a peer, oldest first. Null when `slot` holds an empty
 *  element or anything that is not standard base64: the store holds something
 *  this code cannot interpret, which callers treat as unavailable, not unpinned. */
export function decodePinSlot(slot: string): readonly string[] | null {
  const parts = slot.split(PIN_SEPARATOR);
  if (!parts.every((part) => STD_BASE64.test(part))) return null;
  return [...new Set(parts)];
}

/** The string to store for `keys` (oldest first, at least one). */
export function encodePinSlot(keys: readonly string[]): string {
  return keys.join(PIN_SEPARATOR);
}

/** `keys` with `key` appended (newest last), capped at MAX_PINS_PER_USER by
 *  dropping the oldest. A key already present leaves the set unchanged. */
export function withPin(keys: readonly string[], key: string): readonly string[] {
  if (keys.includes(key)) return keys;
  return [...keys, key].slice(-MAX_PINS_PER_USER);
}

/** Every key trusted for a pinned peer. `pins` is only present on a lookup
 *  that holds more than one key; `pin` is always the newest. */
export function trustedPins(lookup: {
  readonly pin: string;
  readonly pins?: readonly string[];
}): readonly string[] {
  return lookup.pins ?? [lookup.pin];
}
