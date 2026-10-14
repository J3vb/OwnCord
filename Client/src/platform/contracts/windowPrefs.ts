/**
 * The two window-lifecycle preferences the native host owns: what the main
 * window's X button does (`minimizeToTray`) and whether a login launch leaves
 * the window hidden (`startMinimized`). They live in the host, not in
 * localStorage, because the host reads them before the webview exists
 * (`src-tauri/src/window_prefs.rs`).
 */
export type WindowPrefName = "minimizeToTray" | "startMinimized";

export interface WindowPrefsState {
  readonly minimizeToTray: boolean;
  readonly startMinimized: boolean;
}

export interface WindowPrefs {
  /** The current values, or null when the host cannot answer. */
  load(): Promise<WindowPrefsState | null>;
  /** Save one preference. False when the host refused or could not save it. */
  set(pref: WindowPrefName, enabled: boolean): Promise<boolean>;
}
