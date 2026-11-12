// Close to tray and Start minimised (`src-tauri/src/window_prefs.rs`). Both
// calls turn a native failure into a typed result: the settings rows read
// "unavailable" and "not saved", never a rejection.
import { createLogger } from "@lib/logger";
import type { WindowPrefName, WindowPrefs, WindowPrefsState } from "../contracts/windowPrefs";

const log = createLogger("windowPrefs");

// The host saves off the UI thread, so two quick toggles sent together could
// be applied out of order. Each save waits for the one before it.
let saves: Promise<unknown> = Promise.resolve();

async function save(pref: WindowPrefName, enabled: boolean): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_window_pref", { pref, enabled });
    return true;
  } catch (err) {
    log.warn("window pref not saved", { pref, error: String(err) });
    return false;
  }
}

function isState(value: unknown): value is WindowPrefsState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.minimizeToTray === "boolean" && typeof v.startMinimized === "boolean";
}

export const windowPrefs: WindowPrefs = {
  async load(): Promise<WindowPrefsState | null> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const state = await invoke<unknown>("get_window_prefs");
      return isState(state) ? state : null;
    } catch (err) {
      log.warn("window prefs unavailable", err);
      return null;
    }
  },
  set(pref: WindowPrefName, enabled: boolean): Promise<boolean> {
    const next = saves.then(() => save(pref, enabled));
    saves = next;
    return next;
  },
};
