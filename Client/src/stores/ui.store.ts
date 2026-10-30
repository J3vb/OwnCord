/**
 * UI store — holds transient UI state: sidebar, modals, collapsed categories.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { loadStoredJson, saveStoredJson } from "@lib/prefs/preferences";
import type { ContentViewId } from "../features/navigation/destinations";

export interface UiState {
  readonly settingsOpen: boolean;
  readonly connectionStatus: "connected" | "reconnecting" | "disconnected";
  /**
   * A dial has failed in the current outage. It stays set through the
   * backoff's later dials; a drop from a live connection, before any dial has
   * failed, leaves it false.
   */
  readonly connectionDialFailed: boolean;
  readonly transientError: string | null;
  /**
   * The server displaced this device's socket because the same account
   * connected from another device (SESSION_REPLACED). The client stays signed
   * in but does not reconnect until the user chooses "Use here".
   */
  readonly sessionReplaced: boolean;
  /**
   * A server that refused this client's protocol epoch. `host` is the server;
   * the two epochs say which side updates. main.ts consumes it when the
   * connect page mounts, to offer the update there — the main page's own
   * notifier never mounts on a refusal.
   */
  readonly updateRequiredHost: UpdateRequired | null;
  readonly collapsedCategories: ReadonlySet<string>;
  readonly sidebarMode: "channels" | "dms";
  readonly activeDmUserId: number | null;
  /**
   * The content view open in place of the chat column, or null. Written
   * only by the page's content navigator (features/navigation/contentView.ts),
   * which also owns the view's lifetime and focus.
   */
  readonly activeView: ContentViewId | null;
  /** The Settings tab the next open should land on (a Q4 notice links to Safety). */
  readonly settingsTab: SettingsTabRequest | null;
  /**
   * Counts the `openSettings(tab)` calls that named a tab. `settingsTab` alone
   * cannot say "asked again": a second request for the same tab leaves it
   * unchanged, so an already-open panel the user has since tabbed away from
   * would never hear it. Absent until the first request.
   */
  readonly settingsTabSeq?: number;
}

/** Settings tabs another surface may open directly. */
export type SettingsTabRequest = "Account" | "Safety" | "My uploads" | "About" | "Notifications";

/**
 * The one `ui.store` fact a protocol-epoch refusal leaves behind:
 * the host plus the two epoch numbers, so the incompatible notice can name
 * which side updates without a second store flag.
 */
export interface UpdateRequired {
  readonly host: string;
  /** The server's epoch, when the refusal carried one. */
  readonly serverEpoch: number | null;
  /** This build's epoch at refusal time. */
  readonly clientEpoch: number;
}

const INITIAL_STATE: UiState = {
  settingsOpen: false,
  connectionStatus: "disconnected",
  connectionDialFailed: false,
  transientError: null,
  sessionReplaced: false,
  updateRequiredHost: null,
  collapsedCategories: new Set(),
  sidebarMode: "channels",
  activeDmUserId: null,
  activeView: null,
  settingsTab: null,
};

export const uiStore = createStore<UiState>(INITIAL_STATE);

/** Open the settings panel, on `tab` when given and shown. */
export function openSettings(tab?: SettingsTabRequest): void {
  uiStore.setState((prev) => ({
    ...prev,
    settingsOpen: true,
    settingsTab: tab ?? null,
    ...(tab !== undefined ? { settingsTabSeq: (prev.settingsTabSeq ?? 0) + 1 } : {}),
  }));
}

/** Close the settings panel. */
export function closeSettings(): void {
  uiStore.setState((prev) => ({
    ...prev,
    settingsOpen: false,
    settingsTab: null,
  }));
}

/** Set the WebSocket connection status. */
export function setConnectionStatus(
  status: "connected" | "reconnecting" | "disconnected",
  dialFailed = false,
): void {
  uiStore.setState((prev) => ({
    ...prev,
    connectionStatus: status,
    connectionDialFailed: dialFailed,
    // A live connection means this device is the one in use again.
    sessionReplaced: status === "connected" ? false : prev.sessionReplaced,
  }));
}

/** Mark this device as signed in elsewhere (or clear it). */
export function setSessionReplaced(replaced: boolean): void {
  uiStore.setState((prev) => ({ ...prev, sessionReplaced: replaced }));
}

/** Set a transient (auto-dismissable) error message. */
export function setTransientError(msg: string | null): void {
  uiStore.setState((prev) => ({
    ...prev,
    transientError: msg,
  }));
}

/** Set the server whose protocol epoch refused this client, with both epochs. */
export function setUpdateRequiredHost(required: UpdateRequired | null): void {
  uiStore.setState((prev) => ({ ...prev, updateRequiredHost: required }));
}

// ---------------------------------------------------------------------------
// Per-server collapsed category persistence
// ---------------------------------------------------------------------------

const COLLAPSED_KEY_PREFIX = "owncord:collapsed:";

/** The server host currently used for persistence. Set via loadCollapsedCategories. */
let currentServerHost: string | null = null;

/** Load collapsed categories from localStorage for a given server host
 *  and set them in the store. */
export function loadCollapsedCategories(serverHost: string): void {
  currentServerHost = serverHost;
  const loaded: ReadonlySet<string> = loadStoredJson(
    COLLAPSED_KEY_PREFIX + serverHost,
    (v) =>
      Array.isArray(v) && v.every((s) => typeof s === "string")
        ? new Set<string>(v)
        : new Set<string>(),
    new Set<string>(),
  );
  uiStore.setState((prev) => ({ ...prev, collapsedCategories: loaded }));
}

/** Save collapsed categories to localStorage for the current server host. */
function saveCollapsedCategories(categories: ReadonlySet<string>): void {
  if (currentServerHost === null) return;
  // Storage unavailable or full: the state still applies for this session.
  saveStoredJson(COLLAPSED_KEY_PREFIX + currentServerHost, [...categories]);
}

/** Toggle a category's collapsed state. Persists to localStorage for the current server. */
export function toggleCategory(category: string): void {
  uiStore.setState((prev) => {
    const next = new Set(prev.collapsedCategories);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    saveCollapsedCategories(next);
    return { ...prev, collapsedCategories: next };
  });
}

/** Collapse every one of `categories`. Persists to localStorage for the current server. */
export function collapseCategories(categories: readonly string[]): void {
  uiStore.setState((prev) => {
    const next = new Set(prev.collapsedCategories);
    for (const category of categories) next.add(category);
    saveCollapsedCategories(next);
    return { ...prev, collapsedCategories: next };
  });
}

/**
 * Translate collapsed entries saved under a category NAME (before categories had ids) to
 * the category's id key, once the channel list says which name is which id, and
 * rewrite the saved list. `keysByName` maps a category name to its group key.
 * An entry that matches no known name stays untouched (the synthetic Voice
 * group's key, or a category not loaded yet), and a set with nothing to
 * translate is left as it is without a write. After this the collapsed state
 * survives a rename, because the id does not change with it.
 */
export function migrateCollapsedCategoryNames(keysByName: ReadonlyMap<string, string>): void {
  const current = uiStore.getState().collapsedCategories;
  let changed = false;
  const next = new Set<string>();
  for (const entry of current) {
    const key = keysByName.get(entry);
    if (key !== undefined && key !== entry) {
      next.add(key);
      changed = true;
    } else {
      next.add(entry);
    }
  }
  if (!changed) return;
  saveCollapsedCategories(next);
  uiStore.setState((prev) => ({ ...prev, collapsedCategories: next }));
}

/** Selector: check if a category is collapsed. */
export function isCategoryCollapsed(category: string): boolean {
  return uiStore.select((s) => s.collapsedCategories.has(category));
}

/** Switch the sidebar between channel mode and DM mode.
 *  Switching back to "channels" clears the active DM user. */
export function setSidebarMode(mode: "channels" | "dms"): void {
  uiStore.setState((prev) => ({
    ...prev,
    sidebarMode: mode,
    activeDmUserId: mode === "channels" ? null : prev.activeDmUserId,
  }));
}

/** Set the currently active DM conversation user ID. */
export function setActiveDmUser(userId: number | null): void {
  uiStore.setState((prev) => ({
    ...prev,
    activeDmUserId: userId,
  }));
}

/** Record the open content view. Only the content navigator calls this. */
export function setActiveView(view: ContentViewId | null): void {
  uiStore.setState((prev) => ({ ...prev, activeView: view }));
}

/** Sign-out or server switch: nothing in `ready` restates the sidebar mode, so
 *  a "dms" mode (and its peer id) would otherwise mount on the next server. The
 *  collapsed categories and their persistence host belong to the old server
 *  too; `loadCollapsedCategories` sets both again on the next mount. */
function resetUiSessionState(): void {
  setSidebarMode("channels");
  currentServerHost = null;
  uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
}

void registerSessionReset("ui:session", resetUiSessionState); // app-lifetime
