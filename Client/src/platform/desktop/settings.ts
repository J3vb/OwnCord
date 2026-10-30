/**
 * Desktop settings persistence: the native surface behind the `SettingsStore`
 * contract — one versioned JSON envelope in the app's settings store
 * (`get_settings` / `save_settings`).
 *
 * Lifted from `lib/presence/profiles.ts`'s `createTauriBackend()` as the read
 * and the write, and nothing else: validating the stored envelope is the
 * app's business, so it lives next to the profile shape it is about
 * (`lib/presence/profiles.ts`). This seam would otherwise be the only way for any
 * other target to reach a pure type guard.
 */
import { invokeOrThrow } from "./nativeInvoke";
import type { SettingsSnapshot, SettingsStore } from "../contracts/settings";

const STORAGE_KEY = "owncord:profiles";

export const settings: SettingsStore = {
  async load(): Promise<SettingsSnapshot | null> {
    const stored = await invokeOrThrow<Record<string, unknown>>("get_settings");
    const raw = stored[STORAGE_KEY];
    if (raw === undefined || raw === null) return null;
    // Handed back exactly as stored — this seam reads the blob and says what
    // shape the app puts there; whether its entries hold up is `createTauriBackend`'s
    // check to make (see lib/presence/profiles.ts).
    return raw as SettingsSnapshot;
  },

  async save(data: SettingsSnapshot): Promise<void> {
    await invokeOrThrow("save_settings", { key: STORAGE_KEY, value: data });
  },
};
