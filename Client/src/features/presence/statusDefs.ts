/**
 * The selectable presence statuses, shared by the status dropdown and the
 * self profile card so the two can never offer different options.
 */

import type { UserStatus } from "@lib/types";
import { formatDate } from "../../i18n/format";
import { shellText } from "../../i18n/shell";
import { isAndroidApp } from "../voice/native/platform";

export interface StatusDef {
  readonly value: UserStatus;
  readonly labelKey: "status.online" | "status.idle" | "status.dnd" | "status.invisible";
  readonly color: string;
  /** The one-line consequence shown under the label, where there is one. */
  readonly noteKey?: "status.dndNote" | "status.invisibleNote";
}

/**
 * "invisible" is its own value now, not "offline" wearing a different label.
 * The server stores it as chosen and shows everyone else offline, so the
 * picker can finally send what it means — and the status survives a reconnect
 * instead of flashing back to online.
 */
export const STATUS_DEFS: readonly StatusDef[] = [
  { value: "online", labelKey: "status.online", color: "var(--green)" },
  { value: "idle", labelKey: "status.idle", color: "var(--yellow)" },
  { value: "dnd", labelKey: "status.dnd", color: "var(--red)", noteKey: "status.dndNote" },
  {
    value: "invisible",
    labelKey: "status.invisible",
    color: "var(--text-micro)",
    noteKey: "status.invisibleNote",
  },
];

/** The one-line note under a status's label, or null where it has none. Do Not
 *  Disturb says "desktop notifications" on a desktop and plain "notifications"
 *  in the Android app. */
export function statusNote(def: StatusDef): string | null {
  if (def.noteKey === undefined) return null;
  if (def.noteKey === "status.dndNote" && isAndroidApp())
    return shellText("status.dndNote.android");
  return shellText(def.noteKey);
}

const TIME_OF_DAY = { hour: "numeric", minute: "2-digit" } as const;

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "3:40 PM", or "Tue 3:40 PM" when it is not today, in the user's clock style. */
function whenText(at: Date, now: Date): string {
  return formatDate(at, sameLocalDay(at, now) ? TIME_OF_DAY : { weekday: "short", ...TIME_OF_DAY });
}

/** The line under a timed status: "Until 3:40 PM". */
export function statusTimerLine(until: number, now: number = Date.now()): string {
  return shellText("status.timerUntil", { when: whenText(new Date(until), new Date(now)) });
}

/**
 * The line saying when your custom status clears itself. "Clears today" when
 * it is the end-of-day choice (the first minute past the coming midnight),
 * "Clears at 3:40 PM" later today, and the weekday too beyond that.
 */
export function customStatusClearsLine(expiresAtIso: string, now: number = Date.now()): string {
  const at = new Date(expiresAtIso);
  const today = new Date(now);
  if (isEndOfDayExpiry(at.getTime(), now)) return shellText("status.clearsToday");
  const time = formatDate(at, TIME_OF_DAY);
  return sameLocalDay(at, today)
    ? shellText("status.clearsAt", { time })
    : shellText("status.clearsOn", { day: formatDate(at, { weekday: "short" }), time });
}

/** Whether an expiry is the "Today" choice: the first minute past the coming
 *  local midnight (the server stores whole seconds, so it lands just after). */
export function isEndOfDayExpiry(at: number, now: number = Date.now()): boolean {
  const day = new Date(now);
  const tomorrow = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const when = new Date(at);
  return sameLocalDay(when, tomorrow) && when.getHours() === 0 && when.getMinutes() === 0;
}

/** The "Clear after" choice that keeps a running expiry: "As set (until 3:40 PM)". */
export function customStatusKeepLabel(at: number, now: number = Date.now()): string {
  return shellText("status.clearAfter.keep", { when: whenText(new Date(at), new Date(now)) });
}

/** The instant (epoch ms) a custom status expires, or null when it has none
 *  or the text is not a date. */
export function parseExpiry(expiresAtIso: string | null | undefined): number | null {
  if (expiresAtIso === null || expiresAtIso === undefined) return null;
  const t = Date.parse(expiresAtIso);
  return Number.isNaN(t) ? null : t;
}
