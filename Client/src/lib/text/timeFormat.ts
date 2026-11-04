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

function readTimeFormat(): TimeFormat {
  const fallback = localeTimeFormat();
  const raw = loadPref<TimeFormat>(TIME_FORMAT_KEY, fallback);
  return (TIME_FORMATS as readonly string[]).includes(raw) ? raw : fallback;
}

// Lazily read on first use, not at import: this module sits under
// `i18n/format.ts`, which tests import with a mocked `@lib/prefs/preferences`, and a
// module-load read would run before that test's mock state is initialized.
let current: TimeFormat | null = null;

export function getTimeFormat(): TimeFormat {
  return (current ??= readTimeFormat());
}

/** Re-read the pref from storage after a `owncord:pref-change` for this key. */
export function refreshTimeFormat(): void {
  current = readTimeFormat();
}

export function saveTimeFormat(value: TimeFormat): void {
  current = value;
  savePref(TIME_FORMAT_KEY, value);
}
