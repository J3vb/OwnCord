/**
 * The choices the own profile card offers: how long a status timer runs and
 * when a custom status clears. Kept out of userStatus.ts, which the startup
 * path loads, because only the card needs them.
 */

/** The durations offered, shortest first. `forever` is the plain pick. */
export const STATUS_DURATIONS = [
  { id: "15m", ms: 15 * 60_000, labelKey: "status.duration.15m" },
  { id: "1h", ms: 60 * 60_000, labelKey: "status.duration.1h" },
  { id: "8h", ms: 8 * 60 * 60_000, labelKey: "status.duration.8h" },
  { id: "24h", ms: 24 * 60 * 60_000, labelKey: "status.duration.24h" },
  { id: "3d", ms: 3 * 24 * 60 * 60_000, labelKey: "status.duration.3d" },
] as const;

// ---------------------------------------------------------------------------
// Custom status "Clear after"
// ---------------------------------------------------------------------------

/** The server's bounds on `custom_status_expires_in`, in seconds. */
export const MIN_CUSTOM_STATUS_EXPIRES_IN = 60;
export const MAX_CUSTOM_STATUS_EXPIRES_IN = 604_800;

export const CLEAR_AFTER_OPTIONS = [
  { id: "today", labelKey: "status.clearAfter.today" },
  { id: "4h", labelKey: "status.clearAfter.4h" },
  { id: "1h", labelKey: "status.clearAfter.1h" },
  { id: "30m", labelKey: "status.clearAfter.30m" },
  { id: "never", labelKey: "status.clearAfter.never" },
] as const;

export type ClearAfterId = (typeof CLEAR_AFTER_OPTIONS)[number]["id"];

export function isClearAfterId(value: string): value is ClearAfterId {
  return CLEAR_AFTER_OPTIONS.some((o) => o.id === value);
}

/** Keep a duration inside what the server accepts: whole seconds, 60..604800. */
export function clampExpiresIn(seconds: number): number {
  return Math.min(
    MAX_CUSTOM_STATUS_EXPIRES_IN,
    Math.max(MIN_CUSTOM_STATUS_EXPIRES_IN, Math.ceil(seconds)),
  );
}

/**
 * The `custom_status_expires_in` for a "Clear after" choice, or undefined for
 * "Don't clear" (the field is then left out). "Today" is the seconds to the
 * next local midnight, and never under the server's 60-second minimum even
 * when it is chosen a few seconds before midnight.
 */
export function clearAfterSeconds(id: ClearAfterId, now: Date = new Date()): number | undefined {
  const fixed = { "30m": 30 * 60, "1h": 60 * 60, "4h": 4 * 60 * 60 } as const;
  if (id === "never") return undefined;
  if (id !== "today") return clampExpiresIn(fixed[id]);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return clampExpiresIn((midnight.getTime() - now.getTime()) / 1000);
}
