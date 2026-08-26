/**
 * Date/time formatting helpers and message grouping logic.
 * Pure functions for timestamp parsing, display formatting, and role resolution.
 */

import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { loadPref } from "@components/settings/helpers";

// -- Constants ----------------------------------------------------------------

export const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

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
const CLOCK_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatTime(iso: string): string {
  const d = parseTimestamp(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFullDate(iso: string): string {
  return FULL_DATE_FORMAT.format(parseTimestamp(iso));
}

/** Discord-style relative timestamp: "Today at 2:34 PM", "Yesterday at 2:34 PM",
 *  or "MM/DD/YYYY H:MM AM/PM" for older dates. */
export function formatMessageTimestamp(iso: string): string {
  const date = parseTimestamp(iso);
  const now = new Date();

  const timeStr = CLOCK_TIME_FORMAT.format(date);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Built from the calendar date, not todayStart - 24h: a DST-transition day
  // is 23 or 25 hours long, and Date normalizes day 0 / negative days.
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  if (date >= todayStart) {
    return `Today at ${timeStr}`;
  }
  if (date >= yesterdayStart) {
    return `Yesterday at ${timeStr}`;
  }

  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy} ${timeStr}`;
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
  if (prev.user.id !== curr.user.id) return false;
  if (prev.deleted || curr.deleted) return false;
  const dt = parseTimestamp(curr.timestamp).getTime() - parseTimestamp(prev.timestamp).getTime();
  return dt < GROUP_THRESHOLD_MS;
}

// -- Role helpers -------------------------------------------------------------

/** Cached value of the roleColors preference. Invalidated on pref change. */
let roleColorsEnabled = loadPref<boolean>("roleColors", true);
window.addEventListener("owncord:pref-change", ((e: CustomEvent<{ key: string }>) => {
  if (e.detail.key === "roleColors") {
    roleColorsEnabled = loadPref<boolean>("roleColors", true);
  }
}) as EventListener);

export function getUserRole(userId: number): string {
  return membersStore.getState().members.get(userId)?.role ?? "member";
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
