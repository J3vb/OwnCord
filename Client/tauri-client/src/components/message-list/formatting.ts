/**
 * Date/time formatting helpers and message grouping logic.
 * Pure functions for timestamp parsing, display formatting, and role resolution.
 */

import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";

// -- Constants ----------------------------------------------------------------

export const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

// -- Timestamp helpers --------------------------------------------------------

/** Parse a timestamp string, appending 'Z' if no timezone info is present
 *  so that UTC timestamps from SQLite are correctly interpreted. */
export function parseTimestamp(raw: string): Date {
  // SQLite datetime('now') produces "2026-03-19 08:29:41" (UTC, no suffix).
  // If there's no Z, +, or T with offset, treat as UTC by appending Z.
  if (!raw.endsWith("Z") && !raw.includes("+") && !/T\d{2}:\d{2}:\d{2}[+-]/.test(raw)) {
    return new Date(raw.replace(" ", "T") + "Z");
  }
  return new Date(raw);
}

export function formatTime(iso: string): string {
  const d = parseTimestamp(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFullDate(iso: string): string {
  return parseTimestamp(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
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

export function getUserRole(userId: number): string {
  return membersStore.getState().members.get(userId)?.role ?? "member";
}

export function roleColorVar(role: string): string {
  switch (role) {
    case "owner": return "var(--role-owner)";
    case "admin": return "var(--role-admin)";
    case "moderator": return "var(--role-mod)";
    default: return "var(--role-member)";
  }
}
