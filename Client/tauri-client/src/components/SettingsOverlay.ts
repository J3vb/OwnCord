/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Appearance, Notifications, Text & Images, Accessibility, Voice & Audio, Keybinds, Advanced, Logs.
 * Subscribes to uiStore for settingsOpen state.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { uiStore } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { loadPref, applyTheme } from "./settings/helpers";
import type { ThemeName } from "./settings/helpers";
import { buildAccountTab } from "./settings/AccountTab";
import { buildAppearanceTab } from "./settings/AppearanceTab";
import { buildNotificationsTab } from "./settings/NotificationsTab";
import { buildTextImagesTab } from "./settings/TextImagesTab";
import { buildAccessibilityTab } from "./settings/AccessibilityTab";
import { createVoiceAudioTab } from "./settings/VoiceAudioTab";
import { buildKeybindsTab } from "./settings/KeybindsTab";
import { buildAdvancedTab } from "./settings/AdvancedTab";
import { createLogsTab } from "./settings/LogsTab";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsOverlayOptions {
  onClose(): void;
  onChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  onUpdateProfile(username: string): Promise<void>;
  onLogout(): void;
  onStatusChange(status: UserStatus): void;
}

export type TabName = "Account" | "Appearance" | "Notifications" | "Text & Images" | "Accessibility" | "Voice & Audio" | "Keybinds" | "Advanced" | "Logs";

const TAB_ICONS: Record<TabName, IconName> = {
  Account: "user",
  Appearance: "palette",
  Notifications: "bell",
  "Text & Images": "image",
  Accessibility: "eye",
  "Voice & Audio": "mic",
  Keybinds: "keyboard",
  Advanced: "settings",
  Logs: "scroll-text",
};

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
  document.documentElement.classList.toggle("reduced-motion", loadPref<boolean>("reducedMotion", false));
  document.documentElement.classList.toggle("high-contrast", loadPref<boolean>("highContrast", false));
  document.documentElement.classList.toggle("large-font", loadPref<boolean>("largeFont", false));
  document.documentElement.style.setProperty(
    "--accent",
    loadPref<string>("accentColor", "#5865f2"),
  );

  if (loadPref<boolean>("syncOsMotion", false)) {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    document.documentElement.classList.toggle("reduced-motion", mq.matches);
    mq.addEventListener("change", (e: MediaQueryListEvent) => {
      document.documentElement.classList.toggle("reduced-motion", e.matches);
    });
  }
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
  let pageTitle: HTMLHeadingElement | null = null;
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
    "Text & Images": () => buildTextImagesTab(ac.signal),
    Accessibility: () => buildAccessibilityTab(ac.signal),
    "Voice & Audio": () => voiceTab.build(),
    Keybinds: () => buildKeybindsTab(ac.signal),
    Advanced: () => buildAdvancedTab(ac.signal),
    Logs: () => logsTab.build(),
  };

  // ---- Core methods ---------------------------------------------------------

  function renderActiveTab(): void {
    if (contentArea === null) return;
    clearChildren(contentArea);
    if (pageTitle === null) return;
    pageTitle.textContent = activeTab;
    contentArea.appendChild(pageTitle);
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

    // User profile section at top of sidebar
    const user = authStore.getState().user;
    const profileSection = createElement("div", { class: "settings-sidebar-profile" });
    const avatarEl = createElement("div", { class: "settings-sidebar-avatar" },
      (user?.username ?? "U").charAt(0).toUpperCase());
    const profileInfo = createElement("div", {});
    const profileName = createElement("div", { class: "settings-sidebar-name" },
      user?.username ?? "Unknown");
    const editProfileLink = createElement("div", { class: "settings-sidebar-edit" }, "Edit Profile");
    editProfileLink.addEventListener("click", () => setActiveTab("Account"), { signal: ac.signal });
    appendChildren(profileInfo, profileName, editProfileLink);
    appendChildren(profileSection, avatarEl, profileInfo);
    sidebar.appendChild(profileSection);

    // "User Settings" category — only Account belongs here
    const userSettingsCat = createElement("div", { class: "settings-cat" }, "User Settings");
    sidebar.appendChild(userSettingsCat);

    const accountBtn = createElement("button", {
      class: `settings-nav-item${activeTab === "Account" ? " active" : ""}`,
    });
    accountBtn.prepend(createIcon(TAB_ICONS["Account"], 18));
    accountBtn.appendChild(document.createTextNode("Account"));
    accountBtn.addEventListener("click", () => setActiveTab("Account"), { signal: ac.signal });
    tabButtons.set("Account", accountBtn);
    sidebar.appendChild(accountBtn);

    // "App Settings" category — remaining tabs
    const appSettingsCat = createElement("div", { class: "settings-cat" }, "App Settings");
    sidebar.appendChild(appSettingsCat);

    const appTabs: readonly TabName[] = ["Appearance", "Notifications", "Text & Images", "Accessibility", "Voice & Audio", "Keybinds", "Advanced", "Logs"];
    for (const name of appTabs) {
      const btn = createElement("button", {
        class: `settings-nav-item${name === activeTab ? " active" : ""}`,
      });
      btn.prepend(createIcon(TAB_ICONS[name], 18));
      btn.appendChild(document.createTextNode(name));
      btn.addEventListener("click", () => setActiveTab(name), { signal: ac.signal });
      tabButtons.set(name, btn);
      sidebar.appendChild(btn);
    }

    // Separator + Log Out at sidebar bottom
    const logoutWrap = createElement("div", { class: "settings-sidebar-logout" });
    const logoutSep = createElement("div", { class: "settings-sep" });
    const logoutBtn = createElement("button", { class: "settings-nav-item danger" }, "Log Out");
    logoutBtn.addEventListener("click", () => options.onLogout(), { signal: ac.signal });
    appendChildren(logoutWrap, logoutSep, logoutBtn);
    sidebar.appendChild(logoutWrap);

    // Page title (h1) at top of content area — created here, inserted in renderActiveTab
    pageTitle = createElement("h1", {}, activeTab);

    // Content
    contentArea = createElement("div", { class: "settings-content" });

    // Close button wrapped with ESC label
    const closeWrap = createElement("div", { class: "settings-close-wrap" });
    const closeBtn = createElement("button", { class: "settings-close-btn" });
    closeBtn.appendChild(createIcon("x", 18));
    closeBtn.addEventListener("click", () => {
      options.onClose();
    }, { signal: ac.signal });
    const escLabel = createElement("div", { class: "settings-esc-label" }, "ESC");
    appendChildren(closeWrap, closeBtn, escLabel);

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && root?.classList.contains("open")) {
        options.onClose();
      }
    }, { signal: ac.signal });

    appendChildren(root, sidebar, contentArea, closeWrap);
    renderActiveTab();

    // Subscribe to uiStore for open/close
    unsubUi = uiStore.subscribeSelector(
      (s) => s.settingsOpen,
      (settingsOpen) => {
        if (settingsOpen) {
          show();
        } else {
          hide();
        }
      },
    );

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
    pageTitle = null;
  }

  function open(): void {
    show();
  }

  function close(): void {
    hide();
  }

  return { mount, destroy, open, close };
}
