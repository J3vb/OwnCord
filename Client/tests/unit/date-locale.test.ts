import { describe, it, expect, afterEach, vi } from "vitest";
import {
  formatDmRowTime,
  formatFullDate,
  formatMessageTimestamp,
} from "../../src/lib/text/formatting";
import { formatFullDateTime } from "../../src/lib/text/discordTimestamp";
import {
  dateLocale,
  getTimeFormat,
  localeTimeFormat,
  saveDateFormat,
  setSystemDateLocale,
} from "../../src/lib/text/timeFormat";

/**
 * Dates and times follow the device language (navigator.language), with the
 * 12h/24h default taken from that locale's hour cycle. A stored clock choice
 * still wins, and catalog words ("Today at") stay English.
 */

const PREF_KEY = "owncord:settings:timeFormat";

function useLanguage(language: string): void {
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
}

function storeTimeFormat(value: "12h" | "24h"): void {
  localStorage.setItem(PREF_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
}

afterEach(() => {
  vi.restoreAllMocks();
  setSystemDateLocale(null);
  saveDateFormat("auto");
  localStorage.removeItem("owncord:settings:dateFormat");
  localStorage.removeItem(PREF_KEY);
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
});

const OLD = new Date(2020, 10, 1, 14, 5).toISOString();

describe("dates follow the device locale", () => {
  it.each([
    ["en-US", "11/01/2020 2:05 PM", "November 1, 2020", "Sunday, November 1, 2020 at 2:05 PM"],
    ["nl-BE", "01/11/2020 14:05", "1 november 2020", "zondag 1 november 2020 om 14:05"],
    ["de-DE", "01.11.2020 14:05", "1. November 2020", "Sonntag, 1. November 2020 um 14:05"],
  ])("%s", (language, timestamp, fullDate, fullDateTime) => {
    useLanguage(language);
    expect(dateLocale()).toBe(language);
    expect(formatMessageTimestamp(OLD)).toBe(timestamp);
    expect(formatFullDate(OLD)).toBe(fullDate);
    expect(formatFullDateTime(new Date(OLD))).toBe(fullDateTime);
  });

  it("writes DM row dates in the locale's order", () => {
    useLanguage("de-DE");
    expect(formatDmRowTime(OLD)).toBe("1. Nov. 2020");
  });

  it("keeps the English catalog words around a local clock", () => {
    useLanguage("nl-BE");
    const today = new Date();
    today.setHours(14, 5, 0, 0);
    expect(formatMessageTimestamp(today.toISOString())).toBe("Today at 14:05");
  });
});

describe("clock default follows the locale's hour cycle", () => {
  it.each([
    ["en-US", "12h"],
    ["nl-BE", "24h"],
    ["de-DE", "24h"],
    ["en-GB", "24h"],
  ] as const)("%s defaults to %s", (language, clock) => {
    useLanguage(language);
    expect(localeTimeFormat()).toBe(clock);
    expect(getTimeFormat()).toBe(clock);
  });

  it("lets a stored choice override the locale default", () => {
    useLanguage("nl-BE");
    storeTimeFormat("12h");
    expect(formatMessageTimestamp(OLD)).toBe("01/11/2020 2:05 p.m.");
    useLanguage("en-US");
    storeTimeFormat("24h");
    expect(formatMessageTimestamp(OLD)).toBe("11/01/2020 14:05");
  });
});

describe("locale fallback", () => {
  it.each(["", "not a locale"])("uses en-US for %j", (language) => {
    useLanguage(language);
    expect(dateLocale()).toBe("en-US");
    expect(formatMessageTimestamp(OLD)).toBe("11/01/2020 2:05 PM");
  });

  it("picks up a language change on the next render", () => {
    useLanguage("en-US");
    expect(formatFullDate(OLD)).toBe("November 1, 2020");
    useLanguage("de-DE");
    expect(formatFullDate(OLD)).toBe("1. November 2020");
  });

  it("re-derives the default clock when the language changes", () => {
    useLanguage("en-US");
    expect(getTimeFormat()).toBe("12h");
    vi.spyOn(navigator, "language", "get").mockReturnValue("nl-BE");
    expect(getTimeFormat()).toBe("24h");
    storeTimeFormat("12h");
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    expect(getTimeFormat()).toBe("12h");
  });
});

describe("the OS region and the date format choice", () => {
  it("prefers the OS region over the display language on Automatic", () => {
    useLanguage("en-US");
    setSystemDateLocale("nl-BE");
    expect(dateLocale()).toBe("nl-BE");
    expect(getTimeFormat()).toBe("24h");
    expect(formatMessageTimestamp(OLD)).toBe("01/11/2020 14:05");
  });

  it("ignores a malformed OS region", () => {
    useLanguage("de-DE");
    setSystemDateLocale("not a locale");
    expect(dateLocale()).toBe("de-DE");
  });

  it.each([
    ["us", "11/01/2020 2:05 PM", "November 1, 2020"],
    ["dayFirst", "01/11/2020 14:05", "1 November 2020"],
    ["iso", "2020-11-01 14:05", "November 1, 2020"],
  ] as const)("pins %s over the OS region", (format, timestamp, fullDate) => {
    setSystemDateLocale("de-DE");
    saveDateFormat(format);
    expect(formatMessageTimestamp(OLD)).toBe(timestamp);
    expect(formatFullDate(OLD)).toBe(fullDate);
  });

  it("keeps a stored clock over a pinned date format's default", () => {
    storeTimeFormat("12h");
    saveDateFormat("iso");
    expect(formatMessageTimestamp(OLD)).toBe("2020-11-01 2:05 p.m.");
  });
});
