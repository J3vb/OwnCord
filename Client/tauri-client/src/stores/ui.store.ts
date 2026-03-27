/**
 * UI store — holds transient UI state: sidebar, modals, theme, collapsed categories.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";

export interface UiState {
  readonly sidebarCollapsed: boolean;
  readonly memberListVisible: boolean;
  readonly settingsOpen: boolean;
  readonly activeModal: string | null;
  readonly theme: "dark" | "neon-glow" | "midnight" | "light";
  readonly connectionStatus: "connected" | "reconnecting" | "disconnected";
  readonly transientError: string | null;
  readonly persistentError: string | null;
  readonly collapsedCategories: ReadonlySet<string>;
  readonly sidebarMode: "channels" | "dms";
  readonly activeDmUserId: number | null;
}

const INITIAL_STATE: UiState = {
  sidebarCollapsed: false,
  memberListVisible: true,
  settingsOpen: false,
  activeModal: null,
  theme: "dark",
  connectionStatus: "disconnected",
  transientError: null,
  persistentError: null,
  collapsedCategories: new Set(),
  sidebarMode: "channels",
  activeDmUserId: null,
};

export const uiStore = createStore<UiState>(INITIAL_STATE);

/** Toggle sidebar collapsed state. */
export function toggleSidebar(): void {
  uiStore.setState((prev) => ({
    ...prev,
    sidebarCollapsed: !prev.sidebarCollapsed,
  }));
}

/** Toggle member list visibility. */
export function toggleMemberList(): void {
  uiStore.setState((prev) => ({
    ...prev,
    memberListVisible: !prev.memberListVisible,
  }));
}

/** Open the settings panel. */
export function openSettings(): void {
  uiStore.setState((prev) => ({
    ...prev,
    settingsOpen: true,
  }));
}

/** Close the settings panel. */
export function closeSettings(): void {
  uiStore.setState((prev) => ({
    ...prev,
    settingsOpen: false,
  }));
}

/** Open a named modal. */
export function openModal(name: string): void {
  uiStore.setState((prev) => ({
    ...prev,
    activeModal: name,
  }));
}

/** Close the active modal. */
export function closeModal(): void {
  uiStore.setState((prev) => ({
    ...prev,
    activeModal: null,
  }));
}

/** Set the UI theme. */
export function setTheme(theme: "dark" | "neon-glow" | "midnight" | "light"): void {
  uiStore.setState((prev) => ({
    ...prev,
    theme,
  }));
}

/** Set the WebSocket connection status. */
export function setConnectionStatus(
  status: "connected" | "reconnecting" | "disconnected",
): void {
  uiStore.setState((prev) => ({
    ...prev,
    connectionStatus: status,
  }));
}

/** Set a transient (auto-dismissable) error message. */
export function setTransientError(msg: string | null): void {
  uiStore.setState((prev) => ({
    ...prev,
    transientError: msg,
  }));
}

/** Set a persistent error message that requires user action. */
export function setPersistentError(msg: string | null): void {
  uiStore.setState((prev) => ({
    ...prev,
    persistentError: msg,
  }));
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
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY_PREFIX + serverHost);
    if (raw === null) {
      uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
      return;
    }
    const parsed = JSON.parse(raw) as string[];
    const loaded: ReadonlySet<string> = new Set(parsed);
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: loaded }));
  } catch {
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
  }
}

/** Save collapsed categories to localStorage for the current server host. */
function saveCollapsedCategories(categories: ReadonlySet<string>): void {
  if (currentServerHost === null) return;
  try {
    localStorage.setItem(
      COLLAPSED_KEY_PREFIX + currentServerHost,
      JSON.stringify([...categories]),
    );
  } catch {
    // localStorage may be unavailable or full — silently ignore
  }
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
