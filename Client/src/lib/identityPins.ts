/**
 * Peer identity pins as a set (encryption key per device).
 *
 * One account can be signed in on several devices, each with its own identity
 * keypair, so a peer is trusted for every key seen for them (TOFU per key), not
 * for one. The pin store still holds ONE string per `{host}:{userId}`; this
 * module defines what that string means so the desktop and browser stores need
 * no change:
 *
 *   - a single key is stored as the bare base64 key, exactly what older clients
 *     wrote. A legacy pin therefore reads as a set of one with no migration
 *     step, and is only rewritten once a second key is added;
 *   - two or more keys are stored as a JSON array of base64 strings, oldest
 *     first. Base64 never starts with `[`, so the two forms cannot be confused.
 */

/** Most keys kept per peer. Adding one more drops the oldest. */
export const MAX_PINS_PER_USER = 10;

/** Keys trusted for a peer, oldest first. Null when `slot` starts like an
 *  array but is not a readable array of strings: the store holds something
 *  this code cannot interpret, which callers treat as unavailable, not unpinned. */
export function decodePinSlot(slot: string): readonly string[] | null {
  if (!slot.startsWith("[")) return slot === "" ? [] : [slot];
  let parsed: unknown;
  try {
    parsed = JSON.parse(slot);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const list: unknown[] = parsed;
  if (!list.every((entry): entry is string => typeof entry === "string" && entry !== "")) {
    return null;
  }
  return [...new Set(list)];
}

/** The string to store for `keys` (oldest first, at least one). */
export function encodePinSlot(keys: readonly string[]): string {
  const [only] = keys;
  return keys.length === 1 && only !== undefined ? only : JSON.stringify(keys);
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
