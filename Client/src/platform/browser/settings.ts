// The browser platform's settings store: one JSON envelope in
// `localStorage`, under the key the desktop store uses. Validating what comes
// back is the app's business (`lib/profiles.ts`), as on desktop.
import type { SettingsSnapshot, SettingsStore } from "../contracts/settings";
import { UnavailableError } from "./unavailable";

const STORAGE_KEY = "owncord:profiles";

/** The page's `localStorage`. Throws when the page has none or may not use it. */
function storage(): Storage {
  const area: Storage | undefined = globalThis.localStorage;
  if (area === undefined || area === null) throw new UnavailableError();
  return area;
}

export const settings: SettingsStore = {
  async load(): Promise<SettingsSnapshot | null> {
    const raw = storage().getItem(STORAGE_KEY);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    // Handed back as stored; the app checks the shape (`lib/profiles.ts`).
    return parsed === null ? null : (parsed as SettingsSnapshot);
  },

  async save(data: SettingsSnapshot): Promise<void> {
    storage().setItem(STORAGE_KEY, JSON.stringify(data));
  },
};
