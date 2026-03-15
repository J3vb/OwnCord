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
  readonly theme: "dark" | "light";
  readonly collapsedCategories: ReadonlySet<string>;
}

const INITIAL_STATE: UiState = {
  sidebarCollapsed: false,
  memberListVisible: true,
  settingsOpen: false,
  activeModal: null,
  theme: "dark",
  collapsedCategories: new Set(),
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
export function setTheme(theme: "dark" | "light"): void {
  uiStore.setState((prev) => ({
    ...prev,
    theme,
  }));
}

/** Toggle a category's collapsed state. */
export function toggleCategory(category: string): void {
  uiStore.setState((prev) => {
    const next = new Set(prev.collapsedCategories);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    return { ...prev, collapsedCategories: next };
  });
}

/** Selector: check if a category is collapsed. */
export function isCategoryCollapsed(category: string): boolean {
  return uiStore.select((s) => s.collapsedCategories.has(category));
}
