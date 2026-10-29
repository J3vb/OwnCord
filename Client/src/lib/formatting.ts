/**
 * Date/time formatting helpers and message grouping logic.
 * Pure functions for timestamp parsing, display formatting, and role resolution.
 */

import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { loadPref, onPrefChange } from "@lib/preferences";
import { getTimeFormat, refreshTimeFormat } from "@lib/timeFormat";
import { setOwnedTimeout } from "@lib/dom";
import { messageStatusText } from "../i18n/messageStatus";
import { isServerRowKind } from "./messageKind";

// -- Constants ----------------------------------------------------------------

export const GROUP_THRESHOLD_MS = 7 * 60 * 1000;

// -- Timestamp helpers --------------------------------------------------------

/** Memoized epoch millis per raw timestamp string. Timestamps are immutable,
 *  and buildVirtualItems re-parses each one several times per render — the
 *  memo removes thousands of Date constructions + regex runs. Bounded FIFO. */
const parsedTimestampCache = new Map<string, number>();
const PARSED_TIMESTAMP_CACHE_MAX = 2000;

/** Parse a timestamp string, appending 'Z' if no timezone info is present
 *  so that UTC timestamps from SQLite are correctly interpreted. */
export function parseTimestamp(raw: string): Date {
  const cached = parsedTimestampCache.get(raw);
  if (cached !== undefined) return new Date(cached);

  // SQLite datetime('now') produces "2026-03-19 08:29:41" (UTC, no suffix).
  // If there's no Z, +, or T with offset, treat as UTC by appending Z.
  const date =
    !raw.endsWith("Z") && !raw.includes("+") && !/T\d{2}:\d{2}:\d{2}[+-]/.test(raw)
      ? new Date(raw.replace(" ", "T") + "Z")
      : new Date(raw);

  const ms = date.getTime();
  if (!Number.isNaN(ms)) {
    if (parsedTimestampCache.size >= PARSED_TIMESTAMP_CACHE_MAX) {
      // Evict oldest entry (first inserted key)
      const firstKey = parsedTimestampCache.keys().next().value;
      if (firstKey !== undefined) parsedTimestampCache.delete(firstKey);
    }
    parsedTimestampCache.set(raw, ms);
  }
  return date;
}

// Cached formatters — Intl.DateTimeFormat construction is expensive and these
// run for every rendered message. Only the FORMATTER is cached, never a
// formatted string: "Today"/"Yesterday" flips at midnight, so strings are
// recomputed per call from the cached formatter.
const FULL_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

// One clock formatter per preference. `getTimeFormat()` is a cached read, and
// the 24h variant only exists once a user opts in.
const CLOCK_TIME_FORMATS: Record<"12h" | "24h", Intl.DateTimeFormat> = {
  "12h": new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }),
  "24h": new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }),
};

function clockTimeFormat(): Intl.DateTimeFormat {
  return CLOCK_TIME_FORMATS[getTimeFormat()];
}

export function formatTime(iso: string): string {
  const d = parseTimestamp(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFullDate(iso: string): string {
  return FULL_DATE_FORMAT.format(parseTimestamp(iso));
}

/** The clock time alone ("2:34 PM", or "14:34" in 24-hour mode), as the
 *  message header writes it. */
export function formatClockTime(iso: string): string {
  return clockTimeFormat().format(parseTimestamp(iso));
}

/** Discord-style relative timestamp: "Today at 2:34 PM", "Yesterday at 2:34 PM",
 *  or "MM/DD/YYYY H:MM AM/PM" for older dates. */
export function formatMessageTimestamp(iso: string): string {
  const date = parseTimestamp(iso);
  const now = new Date();

  const timeStr = clockTimeFormat().format(date);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Built from the calendar date, not todayStart - 24h: a DST-transition day
  // is 23 or 25 hours long, and Date normalizes day 0 / negative days.
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  if (date >= todayStart) {
    return messageStatusText("date.today", { time: timeStr });
  }
  if (date >= yesterdayStart) {
    return messageStatusText("date.yesterday", { time: timeStr });
  }

  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy} ${timeStr}`;
}

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const SHORT_DATE_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** A DM row's compact time: the clock time for today ("3:04 PM"), else a short
 *  date ("Sep 29", with the year when it is not this one). "" stays "". The
 *  label changes when the day turns, so rows re-render at each midnight
 *  (atEachMidnight) and carry it in their signature. */
export function formatDmRowTime(iso: string): string {
  if (iso === "") return "";
  const date = parseTimestamp(iso);
  const now = new Date();
  if (date >= new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    return clockTimeFormat().format(date);
  }
  return date.getFullYear() === now.getFullYear()
    ? SHORT_DATE_FORMAT.format(date)
    : SHORT_DATE_YEAR_FORMAT.format(date);
}

/** Run `fn` at every local midnight until `signal` aborts. */
export function atEachMidnight(signal: AbortSignal, fn: () => void): void {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  setOwnedTimeout(
    signal,
    () => {
      fn();
      atEachMidnight(signal, fn);
    },
    midnight.getTime() - now.getTime(),
  );
}

/** The server caps `unread_count` here (see GetChannelUnreadCounts): a count
 *  at or above it is a lower bound, not the real number. */
export const UNREAD_COUNT_CAP = 100;

/** Display text for an unread badge. Counts at or above the wire cap read as
 *  "99+"; the raw count is never shown as a four-digit number. Mention counts
 *  are not capped on the wire, but a muted DM's mentions still reach this
 *  through the DM header total. */
export function formatBadgeCount(count: number): string {
  return count >= UNREAD_COUNT_CAP ? "99+" : String(count);
}

export function isSameDay(a: string, b: string): boolean {
  const da = parseTimestamp(a);
  const db = parseTimestamp(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function shouldGroup(prev: Message, curr: Message): boolean {
  // A server row (call log, group event) is its own block: it never joins a run, and nothing joins it.
  if (isServerRowKind(prev.kind) || isServerRowKind(curr.kind)) return false;
  if (prev.user.id !== curr.user.id) return false;
  if (prev.deleted || curr.deleted) return false;
  // A reply carries its quoted-parent header, so it starts a new block.
  if (curr.replyTo !== null) return false;
  const dt = parseTimestamp(curr.timestamp).getTime() - parseTimestamp(prev.timestamp).getTime();
  return dt < GROUP_THRESHOLD_MS;
}

// -- Role helpers -------------------------------------------------------------

/** Cached value of the roleColors preference. Invalidated on pref change. */
let roleColorsEnabled = loadPref<boolean>("roleColors", true);
onPrefChange(["roleColors", "timeFormat"], (key) => {
  if (key === "roleColors") roleColorsEnabled = loadPref<boolean>("roleColors", true);
  else refreshTimeFormat();
});

export function getUserRole(userId: number): string {
  return membersStore.getState().members.get(userId)?.role ?? "member";
}

/**
 * Name colour for a member: the highest-position held role that has a colour,
 * the same rule as the member list, so chat and list agree. Without
 * `roleIds` (an older server), or when none of them carries a colour, it is
 * `roleColorVar` of the single role name, as before.
 */
export function userRoleColorVar(userId: number): string {
  const member = membersStore.getState().members.get(userId);
  const role = member?.role ?? "member";
  const ids = member?.roleIds;
  if (roleColorsEnabled && ids !== undefined && ids.length > 1) {
    let best: { position: number; color: string } | undefined;
    for (const r of channelsStore.getState().roles) {
      if (!ids.includes(r.id) || r.color == null || r.color === "") continue;
      const position = r.position ?? 0;
      if (best === undefined || position > best.position) best = { position, color: r.color };
    }
    if (best !== undefined) return best.color;
  }
  return roleColorVar(role);
}

/**
 * The author identity to render for a message, resolved against the member
 * store first and the message payload second.
 *
 * The store is preferred because it is the live copy: a rename or an avatar
 * change arrives as a `user_update` and patches every member, while the
 * messages already on screen keep whatever the author looked like when they
 * posted. The payload is the fallback for someone who is not in the member
 * list at all — a deleted account, or a poster from before this session.
 */
export function resolveAuthor(user: {
  id: number;
  username: string;
  avatar: string | null;
  display_name?: string | null;
}): { username: string; displayName: string | null; avatar: string | null } {
  const member = membersStore.getState().members.get(user.id);
  if (member !== undefined) {
    return {
      username: member.username,
      displayName: member.displayName ?? null,
      avatar: member.avatar,
    };
  }
  return {
    username: user.username,
    displayName: user.display_name ?? null,
    avatar: user.avatar,
  };
}

export function roleColorVar(role: string): string {
  if (!roleColorsEnabled) {
    return "var(--role-member)";
  }
  // Prefer the server's role color (shipped in `ready`); the theme variables
  // below are the fallback for the seeded roles when no color is set.
  const serverRole = channelsStore
    .getState()
    .roles.find((r) => r.name.toLowerCase() === role.toLowerCase());
  if (serverRole?.color != null && serverRole.color !== "") {
    return serverRole.color;
  }
  switch (role) {
    case "owner":
      return "var(--role-owner)";
    case "admin":
      return "var(--role-admin)";
    case "moderator":
      return "var(--role-mod)";
    default:
      return "var(--role-member)";
  }
}
