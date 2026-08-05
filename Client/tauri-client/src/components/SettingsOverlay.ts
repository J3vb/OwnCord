/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Appearance, Notifications, Text & Images, Accessibility, Voice & Audio, Keybinds, Advanced, Logs.
 * Subscribes to uiStore for settingsOpen state.
 */

import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { uiStore } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
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
  /**
   * Patch the signed-in user's profile. Every field is optional and omitted
   * means "leave unchanged"; an empty string clears the nullable ones, which
   * is how the API itself distinguishes the two.
   */
  onUpdateProfile(patch: {
    username?: string;
    display_name?: string;
    about?: string;
  }): Promise<void>;
  /** Upload an avatar image. Resolves with the URL the server stored. */
  onUploadAvatar(file: File): Promise<string>;
  onLogout(): void;
  onDeleteAccount(password: string): Promise<void>;
  onStatusChange(status: UserStatus): void;
  onEnableTotp(password: string): Promise<{ qr_uri: string; backup_codes: string[] }>;
  onConfirmTotp(password: string, code: string): Promise<void>;
  onDisableTotp(password: string): Promise<void>;
  /** When false, the Account tab is hidden (e.g. on the connect page). Defaults to true. */
  isAuthenticated?: boolean;
}

export type TabName =
  | "Account"
  | "Appearance"
  | "Notifications"
  | "Text & Images"
  | "Accessibility"
  | "Voice & Audio"
  | "Keybinds"
  | "Advanced"
  | "Logs";

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

/** Stable DOM id for a tab button (aria-labelledby target), e.g. "settings-tab-text-images". */
function tabId(name: TabName): string {
  return `settings-tab-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSettingsOverlay(
  options: SettingsOverlayOptions,
): MountableComponent & { open(): void; close(): void } {
  const ac = new AbortController();
  const authenticated = options.isAuthenticated !== false;
  let root: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let contentArea: HTMLDivElement | null = null;
  let pageTitle: HTMLHeadingElement | null = null;
  let activeTab: TabName = authenticated ? "Account" : "Appearance";
  /** False once the active tab's content has been torn down by `hide()`. */
  let contentLive = false;
  /** Puts focus back on whatever opened the panel; null while closed. */
  let restoreFocus: (() => void) | null = null;
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  let unsubUi: (() => void) | null = null;
  let unsubAuth: (() => void) | null = null;

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
    contentLive = true;
  }

  /** Release resources held by the tab currently on screen. */
  function cleanupActiveTab(): void {
    if (activeTab === "Voice & Audio") voiceTab.cleanup();
    // The Logs tab keeps a live log listener pointed at its (now discarded)
    // list element — drop it so it isn't re-rendering a detached tree.
    if (activeTab === "Logs") logsTab.cleanup();
  }

  function setActiveTab(tab: TabName): void {
    if (tab === activeTab) return;
    // Clean up stateful tabs when switching away
    cleanupActiveTab();
    activeTab = tab;
    for (const [name, btn] of tabButtons) {
      btn.classList.toggle("active", name === tab);
      btn.setAttribute("aria-selected", name === tab ? "true" : "false");
      // Roving tabindex: only the active tab sits in the page Tab order.
      btn.setAttribute("tabindex", name === tab ? "0" : "-1");
    }
    contentArea?.setAttribute("aria-labelledby", tabId(tab));
    renderActiveTab();
  }

  function show(): void {
    const wasOpen = root?.classList.contains("open") ?? false;
    root?.classList.add("open");
    // Closing tore down the live parts of the active tab (mic meter, camera
    // preview, log listener). Rebuild it so a reopened panel shows live state
    // instead of a frozen snapshot — and so every tab re-reads current prefs.
    if (!contentLive) renderActiveTab();
    // Move focus in only on the closed→open transition — a repeated show()
    // would otherwise capture an element inside the panel as the "opener".
    if (!wasOpen && panel !== null) {
      restoreFocus = focusDialog(panel);
    }
  }

  function hide(): void {
    root?.classList.remove("open");
    // Stop camera preview, mic meter, and the log listener when the overlay closes
    cleanupActiveTab();
    contentLive = false;
    // Hand focus back to whatever opened the panel.
    restoreFocus?.();
    restoreFocus = null;
  }

  // ---- MountableComponent ---------------------------------------------------

  function mount(container: Element): void {
    root = createElement("div", { class: "settings-overlay", "data-testid": "settings-overlay" });

    // Sidebar. It doubles as the tablist: the profile block, category headings
    // ("User Settings" / "App Settings") and the Log Out button also live in
    // here, and a tablist should own only tabs — but moving them out would
    // change the structure the e2e selectors pin down, so we accept that the
    // non-tab children are presentational noise inside the tablist (DC-13).
    const sidebar = createElement("div", {
      class: "settings-sidebar",
      role: "tablist",
      "aria-orientation": "vertical",
      "aria-label": "Settings sections",
    });

    // Arrow-key navigation between tabs, activate-on-focus (the simpler
    // conformant flavor of the WAI-ARIA tabs pattern). Vertical list, so only
    // Up/Down move; Home/End jump to the edges; both directions wrap.
    sidebar.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") {
          return;
        }
        const order = [...tabButtons.keys()];
        const current = order.findIndex((name) => tabButtons.get(name) === e.target);
        if (current === -1) return; // e.g. the Log Out button — not a tab
        e.preventDefault();
        let next: number;
        if (e.key === "ArrowDown") next = (current + 1) % order.length;
        else if (e.key === "ArrowUp") next = (current - 1 + order.length) % order.length;
        else if (e.key === "Home") next = 0;
        else next = order.length - 1;
        const name = order[next]!;
        setActiveTab(name);
        tabButtons.get(name)?.focus();
      },
      { signal: ac.signal },
    );

    // User profile section at top of sidebar
    const user = authStore.getState().user;
    const profileSection = createElement("div", { class: "settings-sidebar-profile" });
    const avatarEl = createElement(
      "div",
      { class: "settings-sidebar-avatar" },
      (user?.username ?? "U").charAt(0).toUpperCase(),
    );
    const profileInfo = createElement("div", {});
    const profileName = createElement(
      "div",
      { class: "settings-sidebar-name" },
      user?.username ?? "Unknown",
    );
    const editProfileLink = createElement(
      "div",
      { class: "settings-sidebar-edit" },
      "Edit Profile",
    );
    if (authenticated) {
      editProfileLink.addEventListener("click", () => setActiveTab("Account"), {
        signal: ac.signal,
      });
    } else {
      editProfileLink.style.display = "none";
    }
    appendChildren(profileInfo, profileName, editProfileLink);
    appendChildren(profileSection, avatarEl, profileInfo);
    sidebar.appendChild(profileSection);

    // Keep the sidebar identity in step with the store — renaming yourself on
    // the Account tab used to leave the old name sitting here until restart.
    unsubAuth = authStore.subscribeSelector(
      (s) => s.user?.username,
      (name) => {
        profileName.textContent = name ?? "Unknown";
        avatarEl.textContent = (name ?? "U").charAt(0).toUpperCase();
      },
    );

    // "User Settings" category — only Account belongs here (hidden when not authenticated)
    if (authenticated) {
      const userSettingsCat = createElement("div", { class: "settings-cat" }, "User Settings");
      sidebar.appendChild(userSettingsCat);

      const accountBtn = createElement("button", {
        class: `settings-nav-item${activeTab === "Account" ? " active" : ""}`,
        id: tabId("Account"),
        role: "tab",
        "aria-selected": activeTab === "Account" ? "true" : "false",
        tabindex: activeTab === "Account" ? "0" : "-1",
      });
      accountBtn.prepend(createIcon(TAB_ICONS["Account"], 18));
      accountBtn.appendChild(document.createTextNode("Account"));
      accountBtn.addEventListener("click", () => setActiveTab("Account"), { signal: ac.signal });
      tabButtons.set("Account", accountBtn);
      sidebar.appendChild(accountBtn);
    }

    // "App Settings" category — remaining tabs
    const appSettingsCat = createElement("div", { class: "settings-cat" }, "App Settings");
    sidebar.appendChild(appSettingsCat);

    const appTabs: readonly TabName[] = [
      "Appearance",
      "Notifications",
      "Text & Images",
      "Accessibility",
      "Voice & Audio",
      "Keybinds",
      "Advanced",
      "Logs",
    ];
    for (const name of appTabs) {
      const btn = createElement("button", {
        class: `settings-nav-item${name === activeTab ? " active" : ""}`,
        id: tabId(name),
        role: "tab",
        "aria-selected": name === activeTab ? "true" : "false",
        tabindex: name === activeTab ? "0" : "-1",
      });
      btn.prepend(createIcon(TAB_ICONS[name], 18));
      btn.appendChild(document.createTextNode(name));
      btn.addEventListener("click", () => setActiveTab(name), { signal: ac.signal });
      tabButtons.set(name, btn);
      sidebar.appendChild(btn);
    }

    if (authenticated) {
      // Separator + Log Out at sidebar bottom
      const logoutWrap = createElement("div", { class: "settings-sidebar-logout" });
      const logoutSep = createElement("div", { class: "settings-sep" });
      const logoutBtn = createElement("button", { class: "settings-nav-item danger" }, "Log Out");
      logoutBtn.addEventListener("click", () => options.onLogout(), { signal: ac.signal });
      appendChildren(logoutWrap, logoutSep, logoutBtn);
      sidebar.appendChild(logoutWrap);
    }

    // Page title (h1) at top of content area — created here, inserted in renderActiveTab
    pageTitle = createElement("h1", {}, activeTab);

    // Content — the single tabpanel, renamed per switch via aria-labelledby
    contentArea = createElement("div", {
      class: "settings-content",
      role: "tabpanel",
      "aria-labelledby": tabId(activeTab),
    });

    // Close button wrapped with ESC label
    const closeWrap = createElement("div", { class: "settings-close-wrap" });
    const closeBtn = createElement("button", { class: "settings-close-btn" });
    closeBtn.appendChild(createIcon("x", 18));
    closeBtn.addEventListener(
      "click",
      () => {
        options.onClose();
      },
      { signal: ac.signal },
    );
    const escLabel = createElement("div", { class: "settings-esc-label" }, "ESC");
    appendChildren(closeWrap, closeBtn, escLabel);

    // Escape key
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && root?.classList.contains("open")) {
          options.onClose();
        }
      },
      { signal: ac.signal },
    );

    // Inner panel (Discord-style centered card)
    panel = createElement("div", { class: "settings-panel" });
    applyDialogSemantics(panel, { label: "Settings" });
    // Arming the trap while hidden is safe: Tab can't land inside a
    // display:none panel, so the handler only fires while the overlay is open.
    trapFocus(panel, ac.signal);
    appendChildren(panel, sidebar, contentArea, closeWrap);

    // Click backdrop (outside panel) to close
    root.addEventListener(
      "click",
      (e: MouseEvent) => {
        if (e.target === root) options.onClose();
      },
      { signal: ac.signal },
    );

    root.appendChild(panel);
    renderActiveTab();
    // Content built while the panel is closed is only a placeholder: opening
    // rebuilds it so the first view is as fresh as every later one.
    contentLive = uiStore.getState().settingsOpen;

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
    if (unsubAuth !== null) {
      unsubAuth();
      unsubAuth = null;
    }
    logsTab.cleanup();
    voiceTab.cleanup();
    tabButtons.clear();
    // Tearing down while open still hands focus back to the opener.
    restoreFocus?.();
    restoreFocus = null;
    if (root !== null) {
      root.remove();
      root = null;
    }
    panel = null;
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
