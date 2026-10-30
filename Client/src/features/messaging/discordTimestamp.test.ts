import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePref } from "../../lib/prefs/preferences";
import { refreshTimeFormat } from "../../lib/text/timeFormat";
import type { TimestampStyle } from "./discordTimestamp";

/** Loaded inside the tests so the module's own tables are part of what they check. */
function lib(): Promise<typeof import("./discordTimestamp")> {
  return import("./discordTimestamp");
}

/** 2:07:09 PM on Tuesday 5 March 2024, in whatever zone the test runs in. */
const AFTERNOON = new Date(2024, 2, 5, 14, 7, 9);
const AFTERNOON_UNIX = Math.floor(AFTERNOON.getTime() / 1000);
const TITLE_12H = /^Tuesday, March 5, 2024,? (at )?2:07 PM$/;

const NOW_MS = 1_700_000_000_000;
const NOW = NOW_MS / 1000;

async function text(style: TimestampStyle): Promise<string> {
  const { formatDiscordTimestamp } = await lib();
  return formatDiscordTimestamp(AFTERNOON_UNIX, style).text;
}

async function rel(offsetSeconds: number, nowMs = NOW_MS): Promise<string> {
  const { formatDiscordTimestamp } = await lib();
  return formatDiscordTimestamp(NOW + offsetSeconds, "R", nowMs).text;
}

function setClock(format: "12h" | "24h"): void {
  savePref("timeFormat", format);
  refreshTimeFormat();
}

beforeEach(() => {
  localStorage.clear();
  setClock("12h");
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  refreshTimeFormat();
});

describe("formatDiscordTimestamp", () => {
  it("writes every style and every relative unit in the reader's locale", async () => {
    const { formatDiscordTimestamp, formatFullDateTime } = await lib();
    expect(await text("t")).toBe("2:07 PM");
    expect(await text("T")).toBe("2:07:09 PM");
    expect(await text("d")).toBe("03/05/2024");
    expect(await text("D")).toBe("March 5, 2024");
    expect(await text("f")).toMatch(/^March 5, 2024,? (at )?2:07 PM$/);
    expect(await text("F")).toMatch(TITLE_12H);
    expect(formatFullDateTime(AFTERNOON)).toMatch(TITLE_12H);
    expect(formatDiscordTimestamp(AFTERNOON_UNIX, "t", 0).title).toMatch(TITLE_12H);

    expect(await rel(-45)).toBe("45 seconds ago");
    expect(await rel(5400)).toBe("in 2 hours");
    expect(await rel(-86_400)).toBe("1 day ago");
    expect(await rel(3 * 86_400 + 3600)).toBe("in 3 days");
    expect(await rel(30 * 86_400)).toBe("in 1 month");
    expect(await rel(-3 * 30 * 86_400)).toBe("3 months ago");
    expect(await rel(365 * 86_400)).toBe("in 1 year");
    expect(await rel(-2 * 365 * 86_400)).toBe("2 years ago");
    expect(formatDiscordTimestamp(NOW, "R", NOW_MS).title).toMatch(/^[A-Z][a-z]+day, /);
  });

  it("follows the 24-hour clock preference for every style that shows a time", async () => {
    const { formatDiscordTimestamp } = await lib();
    setClock("24h");
    expect(await text("t")).toBe("14:07");
    expect(await text("T")).toBe("14:07:09");
    expect(await text("f")).toMatch(/14:07$/);
    expect(await text("F")).toMatch(/^Tuesday, March 5, 2024,? (at )?14:07$/);
    expect(await text("d")).toBe("03/05/2024");
    expect(formatDiscordTimestamp(AFTERNOON_UNIX, "t", 0).title).toMatch(/14:07$/);
  });

  it("titles every style with the full weekday, date and time", async () => {
    const { formatDiscordTimestamp } = await lib();
    for (const style of ["t", "T", "d", "D", "f", "F", "R"] as const) {
      expect(formatDiscordTimestamp(AFTERNOON_UNIX, style, 0).title).toMatch(TITLE_12H);
    }
  });

  it("switches the title between 12-hour and 24-hour as the preference changes", async () => {
    const { formatFullDateTime } = await lib();
    expect(formatFullDateTime(AFTERNOON)).toMatch(/2:07 PM$/);
    setClock("24h");
    expect(formatFullDateTime(AFTERNOON)).toMatch(/14:07$/);
    setClock("12h");
    expect(formatFullDateTime(AFTERNOON)).toMatch(/2:07 PM$/);
  });
});

describe("formatDiscordTimestamp relative style", () => {
  it("says now for the current second", async () => {
    expect(await rel(0)).toBe("now");
  });

  it("measures the distance to the whole second nearest nowMs", async () => {
    expect(await rel(1, NOW_MS + 400)).toBe("in 1 second");
    expect(await rel(1, NOW_MS + 600)).toBe("now");
    expect(await rel(0, NOW_MS + 600)).toBe("1 second ago");
  });

  it("counts seconds below a minute", async () => {
    expect(await rel(1)).toBe("in 1 second");
    expect(await rel(-1)).toBe("1 second ago");
    expect(await rel(-45)).toBe("45 seconds ago");
    expect(await rel(59)).toBe("in 59 seconds");
  });

  it("switches to the larger unit exactly at its size, in both directions", async () => {
    expect(await rel(60)).toBe("in 1 minute");
    expect(await rel(-60)).toBe("1 minute ago");
    expect(await rel(3599)).toBe("in 60 minutes");
    expect(await rel(3600)).toBe("in 1 hour");
    expect(await rel(-3600)).toBe("1 hour ago");
    expect(await rel(86_399)).toBe("in 24 hours");
    expect(await rel(86_400)).toBe("in 1 day");
    expect(await rel(-86_400)).toBe("1 day ago");
    expect(await rel(30 * 86_400 - 1)).toBe("in 30 days");
    expect(await rel(30 * 86_400)).toBe("in 1 month");
    expect(await rel(-30 * 86_400)).toBe("1 month ago");
    expect(await rel(365 * 86_400 - 1)).toBe("in 12 months");
    expect(await rel(365 * 86_400)).toBe("in 1 year");
    expect(await rel(-365 * 86_400)).toBe("1 year ago");
  });

  it("rounds a mixed distance to the nearest whole unit", async () => {
    expect(await rel(90)).toBe("in 2 minutes");
    expect(await rel(-89)).toBe("1 minute ago");
    expect(await rel(5400)).toBe("in 2 hours");
    expect(await rel(3 * 86_400 + 3600)).toBe("in 3 days");
  });

  it("always counts, never says tomorrow or yesterday", async () => {
    expect(await rel(86_400)).toBe("in 1 day");
    expect(await rel(-86_400)).toBe("1 day ago");
    expect(await rel(-1)).toBe("1 second ago");
  });

  it("anchors on the current time when no nowMs is given", async () => {
    const { formatDiscordTimestamp } = await lib();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    expect(formatDiscordTimestamp(NOW - 120, "R").text).toBe("2 minutes ago");
  });
});
