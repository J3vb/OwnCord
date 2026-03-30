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
