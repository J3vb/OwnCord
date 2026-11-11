// Shape checks for the stored server profiles: one entry, the persistence
// envelope, and the envelope with every entry well-formed. Pure type guards.
import type { ServerProfile, StoredData } from "./profiles";

/**
 * Validates one profile entry of the stored envelope. A pure type guard over a
 * plain object: it belongs to the app, not behind the desktop seam, where a
 * different target's settings store could not reach it.
 */
export function isValidProfileShape(item: unknown): item is ServerProfile {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    obj.name.length > 0 &&
    typeof obj.host === "string" &&
    obj.host.length > 0 &&
    typeof obj.username === "string" &&
    typeof obj.color === "string" &&
    typeof obj.autoConnect === "boolean" &&
    (obj.rememberPassword === undefined || typeof obj.rememberPassword === "boolean") &&
    (obj.lastConnected === null || typeof obj.lastConnected === "string")
  );
}

/**
 * Validates only the persistence envelope shape (schema version + a profiles
 * array), without requiring every individual profile inside it to be
 * well-formed. Used to tell "nothing/garbage was stored" apart from "a valid
 * envelope containing some malformed entries" — the latter should have only the
 * bad entries dropped, not the whole envelope discarded.
 */
export function isValidStoredEnvelope(
  data: unknown,
): data is { schemaVersion: number; profiles: unknown[] } {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.schemaVersion === "number" && Array.isArray(obj.profiles);
}

export function isValidStoredData(data: unknown): data is StoredData {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.schemaVersion === "number" &&
    Array.isArray(obj.profiles) &&
    obj.profiles.every(isValidProfileShape)
  );
}
