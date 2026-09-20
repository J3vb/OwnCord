/**
 * Desktop settings persistence: the native surface behind the `SettingsStore`
 * contract — one versioned JSON envelope in the app's settings store
 * (`get_settings` / `save_settings`).
 *
 * Lifted verbatim from `lib/profiles.ts`'s `createTauriBackend()` (B7-4),
 * including the salvage rule: a well-formed envelope holding one malformed
 * profile keeps the rest of the list (OC-0060), rather than discarding a
 * user's saved profiles because a single entry rotted.
 *
 * The stored-shape predicates live here because this is where the shape is
 * read and written; `lib/profiles.ts` imports them for the file-import path,
 * which validates the very same envelope.
 */
import type { SettingsProfile, SettingsSnapshot, SettingsStore } from "../contracts/settings";

const STORAGE_KEY = "owncord:profiles";

/** Validates one profile entry of the stored envelope. */
export function isValidProfileShape(item: unknown): item is SettingsProfile {
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
 * Validates only the persistence envelope shape (schema version + a
 * profiles array), without requiring every individual profile inside it to
 * be well-formed. Used to tell "nothing/garbage was stored" apart from "a
 * valid envelope containing some malformed entries" — the latter should
 * have only the bad entries dropped, not the whole envelope discarded.
 */
export function isValidStoredEnvelope(
  data: unknown,
): data is { schemaVersion: number; profiles: unknown[] } {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.schemaVersion === "number" && Array.isArray(obj.profiles);
}

export const settings: SettingsStore = {
  async load(): Promise<SettingsSnapshot | null> {
    const { invoke } = await import("@tauri-apps/api/core");
    const stored = await invoke<Record<string, unknown>>("get_settings");
    const raw = stored[STORAGE_KEY];
    if (raw === undefined || raw === null) return null;
    if (!isValidStoredEnvelope(raw)) return null;
    // The envelope itself is well-formed; salvage whichever individual
    // profiles are valid rather than discarding the entire stored list
    // because one entry is malformed (see OC-0060). Mirrors the per-item
    // tolerance importProfiles() already has.
    return {
      schemaVersion: raw.schemaVersion,
      profiles: raw.profiles.filter(isValidProfileShape),
    };
  },

  async save(data: SettingsSnapshot): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_settings", { key: STORAGE_KEY, value: data });
  },
};
