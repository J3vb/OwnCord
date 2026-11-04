/**
 * The client clock-format preference (12-hour or 24-hour) and the locale
 * dates and times are written in.
 *
 * Dates follow the device language (navigator.language), so day/month order
 * and the default clock match what the user reads everywhere else. Catalog
 * text, plurals and numbers stay English (`TEXT_LOCALE`). Without a stored
 * choice the clock defaults to the locale's own hour cycle; a choice made in
 * Settings overrides it.
 *
 * A leaf module — it imports only `preferences.ts` — so both the low-level
 * `i18n/format.ts` and `lib/text/formatting.ts` can read it without a cycle.
 *
 * The value is cached here and refreshed by the app-lifetime `owncord:pref-change`
 * listener in `lib/text/formatting.ts` (and set directly by `saveTimeFormat`), so
 * hot timestamp formatters do not touch localStorage on every call.
 */

import { loadPref, savePref } from "../prefs/preferences";

export type TimeFormat = "12h" | "24h";

const TIME_FORMAT_KEY = "timeFormat";

const FALLBACK_DATE_LOCALE = "en-US";

const TIME_FORMATS: readonly TimeFormat[] = ["12h", "24h"];

let checkedLanguage: string | null = null;
let checkedLocale = FALLBACK_DATE_LOCALE;

/** The locale dates and times are written in: the device language when the
 *  engine knows it, else en-US. Read per call so a language change applies
 *  to the next render; the validation is memoized per language tag. */
export function dateLocale(): string {
  const language = typeof navigator === "undefined" ? "" : navigator.language;
  if (language === checkedLanguage) return checkedLocale;
  checkedLanguage = language;
  checkedLocale = FALLBACK_DATE_LOCALE;
  if (language !== "") {
    try {
      checkedLocale = Intl.DateTimeFormat.supportedLocalesOf([language])[0] ?? FALLBACK_DATE_LOCALE;
    } catch {
      // A malformed tag throws a RangeError; keep the fallback.
    }
  }
  return checkedLocale;
}

/** The clock a locale writes by default: 12-hour for h11/h12 (en-US), else 24-hour. */
export function localeTimeFormat(locale: string = dateLocale()): TimeFormat {
  const { hourCycle } = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
  return hourCycle === "h11" || hourCycle === "h12" ? "12h" : "24h";
}

// The stored choice, or the locale default when nothing is stored. A default
// remembers the language it came from, so a language change re-derives it.
let current: TimeFormat | null = null;
let defaultLanguage: string | null = null;

function readTimeFormat(): TimeFormat {
  // A string fallback: loadPref rejects a stored value whose type differs from it.
  const raw = loadPref<string>(TIME_FORMAT_KEY, "");
  const stored = TIME_FORMATS.find((format) => format === raw);
  if (stored !== undefined) {
    defaultLanguage = null;
    return stored;
  }
  defaultLanguage = dateLocale();
  return localeTimeFormat(defaultLanguage);
}

// Lazily read on first use, not at import: this module sits under
// `i18n/format.ts`, which tests import with a mocked `@lib/prefs/preferences`, and a
// module-load read would run before that test's mock state is initialized.
export function getTimeFormat(): TimeFormat {
  if (current === null || (defaultLanguage !== null && defaultLanguage !== dateLocale())) {
    current = readTimeFormat();
  }
  return current;
}

/** Re-read the pref from storage after a `owncord:pref-change` for this key. */
export function refreshTimeFormat(): void {
  current = readTimeFormat();
}

export function saveTimeFormat(value: TimeFormat): void {
  current = value;
  defaultLanguage = null;
  savePref(TIME_FORMAT_KEY, value);
}
