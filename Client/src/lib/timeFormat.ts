/**
 * The client clock-format preference: 12-hour (default) or 24-hour.
 *
 * A leaf module — it imports only `preferences.ts` — so both the low-level
 * `i18n/format.ts` and `lib/formatting.ts` can read it without a cycle.
 *
 * The value is cached here and refreshed by the app-lifetime `owncord:pref-change`
 * listener in `lib/formatting.ts` (and set directly by `saveTimeFormat`), so
 * hot timestamp formatters do not touch localStorage on every call.
 */

import { loadPref, savePref } from "./preferences";

export type TimeFormat = "12h" | "24h";

const TIME_FORMAT_KEY = "timeFormat";

const DEFAULT_TIME_FORMAT: TimeFormat = "12h";

// Lazily read on first use, not at import: this module sits under
// `i18n/format.ts`, which tests import with a mocked `@lib/preferences`, and a
// module-load read would run before that test's mock state is initialized.
let current: TimeFormat | null = null;

export function getTimeFormat(): TimeFormat {
  return (current ??= loadPref<TimeFormat>(TIME_FORMAT_KEY, DEFAULT_TIME_FORMAT));
}

/** Re-read the pref from storage after a `owncord:pref-change` for this key. */
export function refreshTimeFormat(): void {
  current = loadPref<TimeFormat>(TIME_FORMAT_KEY, DEFAULT_TIME_FORMAT);
}

export function saveTimeFormat(value: TimeFormat): void {
  current = value;
  savePref(TIME_FORMAT_KEY, value);
}
