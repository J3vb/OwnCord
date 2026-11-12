/**
 * The client clock-format preference (12-hour or 24-hour), the date-format
 * preference, and the locale dates and times are written in.
 *
 * On "Automatic", dates follow the OS regional format when the desktop host
 * reports one, else the device language (navigator.language), so day/month
 * order and the default clock match what the user reads everywhere else. The
 * other date formats pin an English locale with that order. Catalog text,
 * plurals and numbers stay English (`TEXT_LOCALE`). Without a stored choice
 * the clock defaults to the date locale's own hour cycle; a choice made in
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

/** "auto" follows the OS region or device language; the others pin an order:
 *  month first (11/01/2026), day first (01/11/2026), year first (2026-11-01). */
export type DateFormat = "auto" | "us" | "dayFirst" | "iso";

const TIME_FORMAT_KEY = "timeFormat";
const DATE_FORMAT_KEY = "dateFormat";

export const DATE_FORMATS: readonly DateFormat[] = ["auto", "us", "dayFirst", "iso"];

// English month names in every pinned order. en-CA writes numeric dates year
// first; its h23 extension keeps the default clock 24-hour, as ISO readers expect.
const PINNED_DATE_LOCALES: Readonly<Record<Exclude<DateFormat, "auto">, string>> = {
  us: "en-US",
  dayFirst: "en-GB",
  iso: "en-CA-u-hc-h23",
};

const FALLBACK_DATE_LOCALE = "en-US";

const TIME_FORMATS: readonly TimeFormat[] = ["12h", "24h"];

/** `tag` as the engine supports it, or null for an empty, malformed or
 *  unknown tag. */
function supportedLocale(tag: string): string | null {
  if (tag === "") return null;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag])[0] ?? null;
  } catch {
    // A malformed tag throws a RangeError.
    return null;
  }
}

let checkedLanguage: string | null = null;
let checkedLocale = FALLBACK_DATE_LOCALE;

function languageLocale(): string {
  const language = typeof navigator === "undefined" ? "" : navigator.language;
  if (language !== checkedLanguage) {
    checkedLanguage = language;
    checkedLocale = supportedLocale(language) ?? FALLBACK_DATE_LOCALE;
  }
  return checkedLocale;
}

let systemLocale: string | null = null;

/** The OS regional format, read once at startup by the desktop host; null
 *  (the browser, a failed read) leaves dates on the device language. */
export function setSystemDateLocale(tag: string | null): void {
  systemLocale = tag === null ? null : supportedLocale(tag);
}

let dateFormat: DateFormat | null = null;

function readDateFormat(): DateFormat {
  const raw = loadPref<string>(DATE_FORMAT_KEY, "auto");
  return DATE_FORMATS.find((format) => format === raw) ?? "auto";
}

export function getDateFormat(): DateFormat {
  return (dateFormat ??= readDateFormat());
}

/** Re-read the pref from storage after a `owncord:pref-change` for this key. */
export function refreshDateFormat(): void {
  dateFormat = readDateFormat();
}

export function saveDateFormat(value: DateFormat): void {
  dateFormat = value;
  savePref(DATE_FORMAT_KEY, value);
}

/** The locale dates and times are written in: a pinned date format's, else
 *  the OS region, else the device language, else en-US. Read per call so a
 *  change applies to the next render. */
export function dateLocale(): string {
  const format = getDateFormat();
  if (format !== "auto") return PINNED_DATE_LOCALES[format];
  return systemLocale ?? languageLocale();
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
