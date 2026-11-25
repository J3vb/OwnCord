// Moderation times as text. Server timestamps are read against the safety
// store's server clock, so an expiry shows the same moment the server enforces.
import { formatDate } from "../../i18n/format";
import { serverNow, serverTime } from "./store";

/** A server timestamp as a date and time, e.g. "Sep 23, 2026, 2:05 PM". */
export function formatWhen(raw: string): string {
  return formatDate(serverTime(raw), { dateStyle: "medium", timeStyle: "short" });
}

/** An expiry: only the time when it is today, else the date and time. */
export function formatUntil(raw: string, now: number = serverNow()): string {
  const at = serverTime(raw);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? formatDate(at, { timeStyle: "short" }) : formatWhen(raw);
}
