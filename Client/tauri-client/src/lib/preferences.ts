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

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
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

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    // Dispatch a custom event so same-window listeners can invalidate caches.
    // The native `storage` event only fires for cross-tab changes.
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key } }));
  } catch {
    // localStorage may throw on quota exceeded or when storage is disabled.
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
  const currentRaw = localStorage.getItem(STORAGE_PREFIX + key);
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

  const legacyRaw = localStorage.getItem(key);
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
