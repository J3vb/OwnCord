import { describe, it, expect, afterEach } from "vitest";
import { formatMessageTimestamp, formatDmRowTime } from "../../src/lib/formatting";
import { formatDate } from "../../src/i18n/format";

/**
 * The client clock format preference (12-hour default, 24-hour opt-in),
 * persisted under `owncord:settings:timeFormat` and applied through the shared
 * timestamp formatters.
 */

function setTimeFormat(value: "12h" | "24h"): void {
  localStorage.setItem("owncord:settings:timeFormat", JSON.stringify(value));
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
}

afterEach(() => {
  localStorage.removeItem("owncord:settings:timeFormat");
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
});

describe("time format preference", () => {
  it("defaults to the 12-hour clock", () => {
    const iso = new Date(2020, 5, 15, 18, 34).toISOString();
    expect(formatMessageTimestamp(iso)).toContain("6:34 PM");
  });

  it("formats messages on the 24-hour clock when set to 24h", () => {
    setTimeFormat("24h");
    const iso = new Date(2020, 5, 15, 18, 34).toISOString();
    const out = formatMessageTimestamp(iso);
    expect(out).toContain("18:34");
    expect(out).not.toMatch(/AM|PM/i);
  });

  it("formats DM rows on the 24-hour clock when set to 24h", () => {
    setTimeFormat("24h");
    const today = new Date();
    today.setHours(18, 34, 0, 0);
    expect(formatDmRowTime(today.toISOString())).toBe("18:34");
  });

  it("formats dates with a time on the 24-hour clock when set to 24h", () => {
    setTimeFormat("24h");
    expect(formatDate(new Date(2020, 5, 15, 18, 34), { timeStyle: "short" })).toBe("18:34");
  });

  it("keeps the 12-hour clock for dates when unset", () => {
    expect(formatDate(new Date(2020, 5, 15, 18, 34), { timeStyle: "short" })).toBe("6:34 PM");
  });

  it("falls back to the 12-hour clock for an invalid stored value", () => {
    localStorage.setItem("owncord:settings:timeFormat", JSON.stringify("13h"));
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
    const iso = new Date(2020, 5, 15, 18, 34).toISOString();
    expect(formatMessageTimestamp(iso)).toContain("6:34 PM");
  });
});
