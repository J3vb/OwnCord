/**
 * Preference persistence helpers.
 *
 * Moved here from `@components/settings/helpers` so that `lib/` modules can
 * depend on these utilities without importing from the component layer.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STORAGE_PREFIX = "owncord:settings:";

/** The window event `savePref` fires; listen through `onPrefChange`. */
export const PREF_CHANGE_EVENT = "owncord:pref-change";

// ---------------------------------------------------------------------------
// Guarded storage access
//
// The only module that touches `localStorage` (src/features/storageDoor.test.ts
// holds that). Storage can be missing, blocked, full or hold anything, so every
// call here is guarded: a read that fails reads as absent, a write that fails
// returns false, and nothing throws to the caller. Keys are full keys; the
// pref helpers below add STORAGE_PREFIX themselves.
// ---------------------------------------------------------------------------

/** The string stored under `key`, or null when there is none or storage is unusable. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store `value` under `key`; false when storage is full or unusable. */
export function writeStored(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove `key`; false when storage is unusable. */
export function removeStored(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Every stored key, or none when storage is unusable. */
export function storedKeys(): string[] {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
}

/**
 * The JSON value under `key`, passed through `parse` (which narrows it and may
 * throw). `fallback` when the key is absent, unparsable or rejected.
 */
export function loadStoredJson<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  const raw = readStored(key);
  if (raw === null) return fallback;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/** Store `value` as JSON under `key`; false when storage is full or unusable. */
export function saveStoredJson(key: string, value: unknown): boolean {
  return writeStored(key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = readStored(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Basic typeof guard against corrupted localStorage (covers boolean,
    // number, string fallbacks used by current call sites).
    if (parsed === null || typeof parsed !== typeof fallback) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/**
 * Run `handler` with the changed key whenever `savePref` writes one of `keys`
 * in this window, or any key when `keys` is "any" (an event without a key
 * reaches only "any" listeners, as ""). Without `signal` the listener lives as
 * long as the app; tests/unit/lifecycle-ownership.test.ts counts such a call
 * the same as a bare listener. Returns a function that removes it.
 */
export function onPrefChange(
  keys: readonly string[] | "any",
  handler: (key: string) => void,
  signal?: AbortSignal,
): () => void {
  const listener = (e: Event): void => {
    const detail: unknown = (e as Partial<CustomEvent<unknown>>).detail;
    const key =
      typeof detail === "object" &&
      detail !== null &&
      "key" in detail &&
      typeof detail.key === "string"
        ? detail.key
        : "";
    if (keys === "any" || (key !== "" && keys.includes(key))) handler(key);
  };
  window.addEventListener(PREF_CHANGE_EVENT, listener, { signal });
  return () => window.removeEventListener(PREF_CHANGE_EVENT, listener);
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    // Dispatch a custom event so same-window listeners can invalidate caches.
    // The native `storage` event only fires for cross-tab changes.
    window.dispatchEvent(new CustomEvent(PREF_CHANGE_EVENT, { detail: { key } }));
  } catch (err) {
    // console, not ./logger: logger reads its level from this module, so
    // importing it here would be an import cycle.
    console.warn("[preferences] Failed to save preference (localStorage may be full or disabled)", {
      key,
      err,
    });
  }
}

/**
 * Read a string-valued pref restricted to `allowedValues`, migrating a legacy
 * unprefixed localStorage entry forward when the prefixed key is unset.
 * Legacy values were stored either raw or JSON-encoded; a migrated value is
 * re-saved under the prefixed key via savePref.
 */
export function readMigratedStringPref<T extends string>(
  key: string,
  fallback: T,
  allowedValues: readonly T[],
): T {
  const currentRaw = readStored(STORAGE_PREFIX + key);
  if (currentRaw !== null) {
    try {
      const currentValue: unknown = JSON.parse(currentRaw);
      if (typeof currentValue === "string" && allowedValues.includes(currentValue as T)) {
        return currentValue as T;
      }
    } catch {
      // Ignore corrupted current storage and fall back below.
    }
  }

  const legacyRaw = readStored(key);
  if (legacyRaw !== null) {
    let legacyValue: unknown = legacyRaw;
    try {
      legacyValue = JSON.parse(legacyRaw);
    } catch {
      // Legacy values were previously stored as raw strings.
    }
    if (typeof legacyValue === "string" && allowedValues.includes(legacyValue as T)) {
      savePref(key, legacyValue);
      return legacyValue as T;
    }
  }

  return fallback;
}
