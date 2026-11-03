/**
 * Discord's `<t:unix:style>` message timestamps, written in the reader's own
 * time zone and clock preference. Pure: the renderer decides the element.
 */
import { TEXT_LOCALE, formatDate } from "../../i18n/format";
import { getTimeFormat } from "../../lib/text/timeFormat";

/** Discord's timestamp styles; `f` is the default. */
export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

const STYLE_OPTIONS: Record<Exclude<TimestampStyle, "R">, Intl.DateTimeFormatOptions> = {
  t: { hour: "numeric", minute: "2-digit" },
  T: { hour: "numeric", minute: "2-digit", second: "2-digit" },
  d: { year: "numeric", month: "2-digit", day: "2-digit" },
  D: { year: "numeric", month: "long", day: "numeric" },
  f: { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
  F: {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
};

const fullFormats: { h12?: Intl.DateTimeFormat; h24?: Intl.DateTimeFormat } = {};

/** Weekday, date and time ("F" style) for a tooltip. The formatter is built
 *  once per clock preference, not once per call: a list draws one per row. */
export function formatFullDateTime(date: Date): string {
  const key = getTimeFormat() === "12h" ? "h12" : "h24";
  fullFormats[key] ??= new Intl.DateTimeFormat(TEXT_LOCALE, {
    ...STYLE_OPTIONS.F,
    hour12: key === "h12",
  });
  return fullFormats[key].format(date);
}

/** Largest unit first: the first whose size fits the gap is used. */
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

let relativeFormat: Intl.RelativeTimeFormat | null = null;
let nowFormat: Intl.RelativeTimeFormat | null = null;

/** "3 days ago" / "in 2 hours" for `unix` seen at `nowMs`. */
function formatRelative(unix: number, nowMs: number): string {
  relativeFormat ??= new Intl.RelativeTimeFormat(TEXT_LOCALE, { numeric: "always" });
  const diff = unix - Math.round(nowMs / 1000);
  const abs = Math.abs(diff);
  if (abs < 1) {
    nowFormat ??= new Intl.RelativeTimeFormat(TEXT_LOCALE, { numeric: "auto" });
    return nowFormat.format(0, "second");
  }
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size) return relativeFormat.format(Math.round(diff / size), unit);
  }
  return relativeFormat.format(diff, "second");
}

/**
 * The visible text of a timestamp in `style`, and the full date and time for
 * its tooltip. `nowMs` anchors the relative style.
 */
export function formatDiscordTimestamp(
  unix: number,
  style: TimestampStyle,
  nowMs: number = Date.now(),
): { readonly text: string; readonly title: string } {
  const date = new Date(unix * 1000);
  const title = formatFullDateTime(date);
  const text = style === "R" ? formatRelative(unix, nowMs) : formatDate(date, STYLE_OPTIONS[style]);
  return { text, title };
}
