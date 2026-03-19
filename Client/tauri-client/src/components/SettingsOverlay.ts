/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Appearance, Notifications, Voice & Audio, Keybinds, Logs.
 * Subscribes to uiStore for settingsOpen state.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { uiStore } from "@stores/ui.store";
import { loadPref, applyTheme } from "./settings/helpers";
import type { ThemeName } from "./settings/helpers";
import { buildAccountTab } from "./settings/AccountTab";
import { buildAppearanceTab } from "./settings/AppearanceTab";
import { buildNotificationsTab } from "./settings/NotificationsTab";
import { createVoiceAudioTab } from "./settings/VoiceAudioTab";
import { buildKeybindsTab } from "./settings/KeybindsTab";
import { createLogsTab } from "./settings/LogsTab";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsOverlayOptions {
  onClose(): void;
  onChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  onUpdateProfile(username: string): Promise<void>;
  onLogout(): void;
}

export type TabName = "Account" | "Appearance" | "Notifications" | "Voice & Audio" | "Keybinds" | "Logs";

const TAB_NAMES: readonly TabName[] = [
  "Account",
  "Appearance",
  "Notifications",
  "Voice & Audio",
  "Keybinds",
  "Logs",
] as const;

// ---------------------------------------------------------------------------
// Apply stored appearance (called at app startup)
// ---------------------------------------------------------------------------

/**
 * Apply stored appearance preferences (theme, font size, compact mode).
 * Call at app startup so the UI doesn't flash default styles.
 */
export function applyStoredAppearance(): void {
  applyTheme(loadPref<ThemeName>("theme", "dark"));
  document.documentElement.style.setProperty(
    "--font-size",
    `${loadPref<number>("fontSize", 16)}px`,
  );
  document.documentElement.classList.toggle(
    "compact-mode",
    loadPref<boolean>("compactMode", false),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSettingsOverlay(
  options: SettingsOverlayOptions,
): MountableComponent & { open(): void; close(): void } {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let contentArea: HTMLDivElement | null = null;
  let activeTab: TabName = "Account";
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  let unsubUi: (() => void) | null = null;

  // Stateful tabs — create via factory for proper cleanup on tab switch
  const logsTab = createLogsTab(() => activeTab, ac.signal);
  const voiceTab = createVoiceAudioTab(ac.signal);

  // ---- Tab content builders -------------------------------------------------

  const TAB_BUILDERS: Readonly<Record<TabName, () => HTMLDivElement>> = {
    Account: () => buildAccountTab(options, ac.signal),
    Appearance: () => buildAppearanceTab(ac.signal),
    Notifications: () => buildNotificationsTab(ac.signal),
    "Voice & Audio": () => voiceTab.build(),
    Keybinds: () => buildKeybindsTab(ac.signal),
    Logs: () => logsTab.build(),
  };

  // ---- Core methods ---------------------------------------------------------

  function renderActiveTab(): void {
    if (contentArea === null) return;
    clearChildren(contentArea);
    const builder = TAB_BUILDERS[activeTab];
    contentArea.appendChild(builder());
  }

  function setActiveTab(tab: TabName): void {
    if (tab === activeTab) return;
    // Clean up stateful tabs when switching away
    if (activeTab === "Voice & Audio") voiceTab.cleanup();
    activeTab = tab;
    for (const [name, btn] of tabButtons) {
      btn.classList.toggle("active", name === tab);
    }
    renderActiveTab();
  }

  function show(): void {
    root?.classList.add("open");
  }

  function hide(): void {
    root?.classList.remove("open");
    // Stop camera preview and mic meter when settings overlay closes
    voiceTab.cleanup();
  }

  // ---- MountableComponent ---------------------------------------------------

  function mount(container: Element): void {
    root = createElement("div", { class: "settings-overlay", "data-testid": "settings-overlay" });

    // Sidebar
    const sidebar = createElement("div", { class: "settings-sidebar" });
    const catLabel = createElement("div", { class: "settings-cat" }, "User Settings");
    sidebar.appendChild(catLabel);
    for (const name of TAB_NAMES) {
      const btn = createElement("button", {
        class: `settings-nav-item${name === activeTab ? " active" : ""}`,
      }, name);
      btn.addEventListener("click", () => setActiveTab(name), { signal: ac.signal });
      tabButtons.set(name, btn);
      sidebar.appendChild(btn);
    }

    // Content
    contentArea = createElement("div", { class: "settings-content" });

    // Close button
    const closeBtn = createElement("button", { class: "settings-close-btn" }, "\u00D7");
    closeBtn.addEventListener("click", () => {
      options.onClose();
    }, { signal: ac.signal });

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && root?.classList.contains("open")) {
        options.onClose();
      }
    }, { signal: ac.signal });

    appendChildren(root, sidebar, contentArea, closeBtn);
    renderActiveTab();

    // Subscribe to uiStore for open/close
    unsubUi = uiStore.subscribe((state) => {
      if (state.settingsOpen) {
        show();
      } else {
        hide();
      }
    });

    // Sync initial state
    if (uiStore.getState().settingsOpen) {
      show();
    }

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (unsubUi !== null) {
      unsubUi();
      unsubUi = null;
    }
    logsTab.cleanup();
    voiceTab.cleanup();
    tabButtons.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
    contentArea = null;
  }

  function open(): void {
    show();
  }

  function close(): void {
    hide();
  }

  return { mount, destroy, open, close };
}
