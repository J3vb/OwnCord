/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Safety (once its feature ships), Appearance, Accessibility, Voice & Video, Text & Images, Notifications, Keybinds, Advanced, Logs, About.
 * Subscribes to uiStore for settingsOpen state.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { isDisplayed } from "@lib/dialogOpen";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { closeOnBackdropClick } from "@lib/modalFactory";
import { createIcon } from "@lib/icons";
import { createLogger } from "@lib/logger";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import type { PartialSuccessResponse, UserStatus } from "@lib/types";
import type {
  RecoveryKitIssue,
  RecoveryKitStatus,
  RevokeAllSessionsResponse,
  SessionInfo,
} from "@lib/api";
import { uiStore } from "@stores/ui.store";
import { settingsText } from "../i18n/settings";
import { authStore } from "@stores/auth.store";
import { createAvatarElement } from "./message-list/avatar";
import { buildAccountTab } from "./settings/AccountTab";
import { buildAppearanceTab } from "./settings/AppearanceTab";
import { buildNotificationsTab } from "./settings/NotificationsTab";
import { buildTextImagesTab } from "./settings/TextImagesTab";
import { buildAccessibilityTab } from "./settings/AccessibilityTab";
import { createVoiceAudioTab } from "./settings/VoiceAudioTab";
import { buildKeybindsTab } from "./settings/KeybindsTab";
import { buildAdvancedTab } from "./settings/AdvancedTab";
import { createLogsTab } from "./settings/LogsTab";
import { highlightMatches, normalizeQuery, tabMatches } from "./settings/settingsSearch";
import { confirmLogout } from "../features/settings/logoutConfirm";
import { readAppVersion } from "../features/whats-new/appVersion";
import { subscribeAvailableUpdate } from "../features/updates/availableUpdate";

const log = createLogger("SettingsOverlay");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsOverlayOptions {
  onClose(): void;
  /** Where focus goes on close when the opener is gone or cannot take focus. */
  fallbackFocus?(): HTMLElement | null;
  /**
   * Change the password. Resolves with the server's partial-success body
   * when the password changed but the other sessions could not be revoked
   * (its `warning` is the instruction the form must keep showing), or with
   * `undefined` on a clean success.
   */
  onChangePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<PartialSuccessResponse | undefined>;
  /**
   * Patch the signed-in user's profile. Every field is optional and omitted
   * means "leave unchanged"; an empty string clears the nullable ones, which
   * is how the API itself distinguishes the two.
   */
  onUpdateProfile(patch: {
    username?: string;
    display_name?: string;
    about?: string;
    /** `#rrggbb`; "" clears. Sent only on a server with `profile_banners`. */
    banner_color?: string;
  }): Promise<void>;
  /** Upload an avatar image. Resolves with the URL the server stored. */
  onUploadAvatar(file: File): Promise<string>;
  /** Remove the avatar (3C-7a). Resolves once the server has cleared it. */
  onRemoveAvatar(): Promise<void>;
  /** Upload a cropped banner image. Resolves with the stored URL.
   *  Omitted: no banner upload control. */
  onUploadBanner?(file: File): Promise<string>;
  /** Remove the banner image. Omitted: no remove control. */
  onRemoveBanner?(): Promise<void>;
  onLogout(): void;
  onDeleteAccount(password: string): Promise<void>;
  /** The server-default retention sentence for the Account tab, or null when
   *  the server did not report one. */
  getRetentionNotice?(): string | null;
  onStatusChange(status: UserStatus): void;
  onEnableTotp(password: string): Promise<{ qr_uri: string; backup_codes: string[] }>;
  onConfirmTotp(password: string, code: string): Promise<void>;
  onDisableTotp(password: string): Promise<void>;
  /** Re-read the 2FA state from GET /users/me, the only response that
   *  carries it, and put it in the auth store. */
  onRefreshTotpStatus(): Promise<void>;
  /** Replace the emergency recovery codes (password-confirmed); resolves with
   *  the new set, which the tab shows once and never keeps. */
  onRegenerateRecoveryCodes(password: string): Promise<string[]>;
  /** Issue or replace the recovery kit (password-confirmed). The secret in
   *  the result is shown once and never kept. */
  onEnrolRecoveryKit(password: string): Promise<RecoveryKitIssue>;
  onGetRecoveryKitStatus(): Promise<RecoveryKitStatus>;
  /** List the account's signed-in devices (GET /users/me/sessions). */
  onListSessions(): Promise<readonly SessionInfo[]>;
  /** Sign one device out; it can no longer connect. */
  onRevokeSession(id: number): Promise<void>;
  /** Sign out every device, this one included. The page clears local auth
   *  when the response reports the current session revoked. */
  onRevokeAllSessions(): Promise<RevokeAllSessionsResponse>;
  /** When false, the Account tab is hidden (e.g. on the connect page). Defaults to true. */
  isAuthenticated?: boolean;
  /** Builds the Safety tab. Absent until its feature ships, and then no tab shows. */
  safetyTab?: (signal: AbortSignal) => HTMLDivElement;
}

export type TabName =
  | "Account"
  | "Safety"
  | "Appearance"
  | "Accessibility"
  | "Voice & Video"
  | "Text & Images"
  | "Notifications"
  | "Keybinds"
  | "Advanced"
  | "Logs"
  | "About";

const TAB_ICONS: Record<TabName, IconName> = {
  Account: "user",
  Safety: "shield",
  Appearance: "palette",
  Accessibility: "eye",
  "Voice & Video": "mic",
  "Text & Images": "image",
  Notifications: "bell",
  Keybinds: "keyboard",
  Advanced: "settings",
  Logs: "scroll-text",
  About: "file-text",
};

// i18n-exempt: TabName key; its label is settingsText("tabs.safety")
const SAFETY = "Safety" satisfies TabName;
// i18n-exempt: TabName key; its label is settingsText("tabs.account")
const ACCOUNT = "Account" satisfies TabName;
// i18n-exempt: TabName key; its label is settingsText("tabs.about")
const ABOUT = "About" satisfies TabName;

/**
 * What each tab is called on screen.
 * The key order is the nav order: Discord's app-settings order, then the
 * OwnCord-only tabs.
 */
const TAB_LABEL_KEYS = {
  Account: "tabs.account",
  Safety: "tabs.safety",
  Appearance: "tabs.appearance",
  Accessibility: "tabs.accessibility",
  "Voice & Video": "tabs.voice",
  "Text & Images": "tabs.textImages",
  Notifications: "tabs.notifications",
  Keybinds: "tabs.keybinds",
  Advanced: "tabs.advanced",
  Logs: "tabs.logs",
  About: "tabs.about",
} as const satisfies Record<TabName, string>;

function tabLabel(name: TabName): string {
  return settingsText(TAB_LABEL_KEYS[name]);
}

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
  const disposable = new Disposable();
  const authenticated = options.isAuthenticated !== false;
  let root: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let contentArea: HTMLDivElement | null = null;
  let pageTitle: HTMLHeadingElement | null = null;
  // i18n-exempt: TabName key; its label is settingsText("tabs.appearance")
  let activeTab: TabName = authenticated ? ACCOUNT : "Appearance";
  /** False once the active tab's content has been torn down by `hide()`. */
  let contentLive = false;
  /** Puts focus back on whatever opened the panel; null while closed. */
  let restoreFocus: (() => void) | null = null;
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  /** The normalized search query; "" when the box is empty. */
  let query = "";
  let searchInput: HTMLInputElement | null = null;
  let searchClear: HTMLButtonElement | null = null;
  let searchEmpty: HTMLElement | null = null;
  let userSettingsCat: HTMLElement | null = null;
  let appSettingsCat: HTMLElement | null = null;
  let unsubUi: (() => void) | null = null;
  let unsubTabRequest: (() => void) | null = null;
  let unsubAuth: (() => void) | null = null;
  let unsubUpdate: (() => void) | null = null;
  /** Closes the open Log Out prompt without confirming; null when none is open. */
  let closeLogoutPrompt: (() => void) | null = null;
  /**
   * Scopes the *current* tab build's element listeners. `renderActiveTab()`
   * aborts the previous one before building the next, so a discarded pane's
   * listeners are dropped immediately instead of accumulating on `disposable` for
   * the whole overlay lifetime — every render used to register
   * against `disposable.signal` directly, and nothing ever aborted a stale build's
   * registrations short of `destroy()`.
   */
  let renderOwner: Disposable | null = null;

  // Stateful tabs — create via factory for proper cleanup on tab switch
  const logsTab = createLogsTab(() => activeTab, disposable.signal);
  const voiceTab = createVoiceAudioTab(disposable.signal);

  // ---- One-time secret guard ------------------------------------------------

  /**
   * A recovery kit or recovery codes response is the only copy of the new
   * secret, and the request has already invalidated the old one. While one is
   * in flight, ignore close and tab switches so the tab's signal cannot abort
   * before the secret is shown. Logout/destroy still tear down regardless.
   */
  let secretRequests = 0;
  function holdOpen<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      secretRequests++;
      try {
        return await fn(...args);
      } finally {
        secretRequests--;
      }
    };
  }
  function requestClose(): void {
    if (secretRequests === 0) options.onClose();
  }

  // ---- Tab content builders -------------------------------------------------

  const TAB_BUILDERS: Readonly<Record<TabName, (signal: AbortSignal) => HTMLDivElement>> = {
    Account: (signal) =>
      buildAccountTab(
        {
          ...options,
          onEnrolRecoveryKit: holdOpen(options.onEnrolRecoveryKit),
          onRegenerateRecoveryCodes: holdOpen(options.onRegenerateRecoveryCodes),
        },
        signal,
      ),
    // Only reachable through its tab button, which exists only with the option.
    Safety: (signal) => options.safetyTab?.(signal) ?? createElement("div"),
    Appearance: (signal) => buildAppearanceTab(signal),
    Notifications: (signal) => buildNotificationsTab(signal),
    "Text & Images": (signal) => buildTextImagesTab(signal),
    Accessibility: (signal) => buildAccessibilityTab(signal),
    "Voice & Video": (signal) => voiceTab.build(signal),
    Keybinds: (signal) => buildKeybindsTab(signal),
    Advanced: (signal) => buildAdvancedTab(signal),
    Logs: (signal) => logsTab.build(signal),
    // Loaded on first open: the release notes renderer stays out of this chunk.
    About: (signal) => {
      const host = createElement("div", { class: "settings-pane active" });
      void import("./settings/AboutTab").then(
        ({ buildAboutTab }) => {
          if (signal.aborted) return;
          host.replaceWith(buildAboutTab(signal));
          // The real tab arrived after renderActiveTab's pass: mark it too.
          markSearchHits();
        },
        (err: unknown) => {
          log.warn("About tab failed to load", { error: String(err) });
        },
      );
      return host;
    },
  };

  // ---- Core methods ---------------------------------------------------------

  function renderActiveTab(): void {
    if (contentArea === null) return;
    // Drop the previous build's listeners before replacing its DOM — see
    // the `renderOwner` comment above.
    renderOwner?.destroy();
    renderOwner = new Disposable();
    const buildSignal = AbortSignal.any([disposable.signal, renderOwner.signal]);
    clearChildren(contentArea);
    if (pageTitle === null) return;
    pageTitle.textContent = tabLabel(activeTab);
    contentArea.appendChild(pageTitle);
    const builder = TAB_BUILDERS[activeTab];
    contentArea.appendChild(builder(buildSignal));
    contentLive = true;
    markSearchHits();
  }

  // ---- Search ---------------------------------------------------------------

  /** The tab buttons the current query leaves on screen, in nav order. */
  function visibleTabs(): TabName[] {
    return [...tabButtons.keys()].filter((name) => tabButtons.get(name)?.hidden !== true);
  }

  /** Highlight the query in the open tab and bring the first hit into view. */
  function markSearchHits(): void {
    if (contentArea === null) return;
    highlightMatches(contentArea, query);
    const hit = Array.from(
      contentArea.querySelectorAll<HTMLElement>("mark.settings-search-hit"),
    ).find((m) => isDisplayed(m));
    hit?.scrollIntoView?.({ block: "center" });
  }

  /** Hide the tabs (and headings) the query rules out; show the rest. */
  function applySearch(): void {
    let any = false;
    for (const [name, btn] of tabButtons) {
      const match = tabMatches(name, tabLabel(name), query);
      btn.hidden = !match;
      any ||= match;
    }
    if (userSettingsCat !== null) {
      userSettingsCat.hidden = !visibleTabs().some((n) => n === ACCOUNT || n === SAFETY);
    }
    if (appSettingsCat !== null) {
      appSettingsCat.hidden = !visibleTabs().some((n) => n !== ACCOUNT && n !== SAFETY);
    }
    if (searchEmpty !== null) searchEmpty.hidden = any;
    if (searchClear !== null) searchClear.hidden = searchInput?.value === "";
    // Keep one tab in the page Tab order when the open one was filtered out.
    const shown = visibleTabs();
    const stop = tabButtons.get(activeTab)?.hidden === false ? activeTab : shown[0];
    for (const [name, btn] of tabButtons) btn.setAttribute("tabindex", name === stop ? "0" : "-1");
    markSearchHits();
  }

  function setQuery(raw: string): void {
    query = normalizeQuery(raw);
    applySearch();
  }

  function clearSearch(): void {
    if (searchInput !== null) searchInput.value = "";
    setQuery("");
  }

  /** Move onto a visible tab from the search box (Up/Down/Enter). */
  function enterTabs(pick: "first" | "last"): void {
    if (query === "") {
      // Nothing to pick from: just move onto the open tab.
      const btn = tabButtons.get(activeTab);
      if (btn?.hidden === false) btn.focus();
      return;
    }
    const shown = visibleTabs();
    const name = pick === "first" ? shown[0] : shown[shown.length - 1];
    if (name === undefined) return;
    setActiveTab(name);
    if (secretRequests === 0) tabButtons.get(name)?.focus();
  }

  /** Release resources held by the tab currently on screen. */
  function cleanupActiveTab(): void {
    if (activeTab === "Voice & Video") voiceTab.cleanup();
    // The Logs tab keeps a live log listener pointed at its (now discarded)
    // list element — drop it so it isn't re-rendering a detached tree.
    if (activeTab === "Logs") logsTab.cleanup();
  }

  function setActiveTab(tab: TabName): void {
    if (tab === activeTab || secretRequests > 0) return;
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

  /** Another surface asked for a tab (a Q4 notice links to Safety, the server
   *  menu to Notifications). A tab that is not shown here is ignored. */
  function applyRequestedTab(): void {
    const requested = uiStore.getState().settingsTab;
    if (requested !== null && requested !== activeTab && tabButtons.has(requested)) {
      // A hidden requested tab would strand the only tab stop: reset search.
      clearSearch();
      setActiveTab(requested);
    }
  }

  function show(): void {
    const wasOpen = root?.classList.contains("open") ?? false;
    root?.classList.add("open");
    applyRequestedTab();
    // Closing tore down the live parts of the active tab (mic meter, camera
    // preview, log listener). Rebuild it so a reopened panel shows live state
    // instead of a frozen snapshot — and so every tab re-reads current prefs.
    if (!contentLive) renderActiveTab();
    // Move focus in only on the closed→open transition — a repeated show()
    // would otherwise capture an element inside the panel as the "opener".
    if (!wasOpen && panel !== null) {
      restoreFocus = focusDialog(panel, options.fallbackFocus);
      // The search box is the first control, but opening should not park
      // the caret there: focus lands on the active tab instead.
      if (document.activeElement === searchInput) tabButtons.get(activeTab)?.focus();
    }
  }

  function hide(): void {
    // A Log Out prompt left open must not outlive the panel it belongs to.
    closeLogoutPrompt?.();
    root?.classList.remove("open");
    // The hidden pane is rebuilt on reopen (contentLive), so drop its build
    // now: anything shown once (recovery codes, a recovery kit secret) is
    // wiped from the DOM rather than lingering while closed. Aborting the
    // build's listeners is not enough — the nodes stay attached until the
    // next renderActiveTab clears them, so a closed overlay kept the last
    // tab's DOM (including the Account tab's asynchronously loaded session
    // rows), and the soak's node count depended on that fetch's race.
    renderOwner?.destroy();
    if (contentArea !== null) clearChildren(contentArea);
    // Stop camera preview, mic meter, and the log listener when the overlay closes
    cleanupActiveTab();
    contentLive = false;
    // A reopened panel starts with an empty search.
    if (query !== "" || searchInput?.value !== "") clearSearch();
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
    // non-tab children are presentational noise inside the tablist.
    const sidebar = createElement("div", {
      class: "settings-sidebar",
      role: "tablist",
      "aria-orientation": "vertical",
      "aria-label": settingsText("shell.sections"),
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
        const order = visibleTabs();
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
        // A blocked switch keeps focus on the selected tab (activate-on-focus).
        if (secretRequests === 0) tabButtons.get(name)?.focus();
      },
      { signal: disposable.signal },
    );

    // Search box above everything else in the nav (3E-3b).
    const searchWrap = createElement("div", { class: "settings-search" });
    searchInput = createElement("input", {
      class: "settings-search-input",
      type: "text",
      placeholder: settingsText("search.placeholder"),
      "aria-label": settingsText("search.label"),
      autocomplete: "off",
      spellcheck: "false",
      "data-testid": "settings-search",
    });
    searchClear = createElement("button", {
      class: "settings-search-clear",
      type: "button",
      "aria-label": settingsText("search.clear"),
      "data-testid": "settings-search-clear",
    });
    searchClear.hidden = true;
    searchClear.appendChild(createIcon("x", 14));
    searchEmpty = createElement(
      "div",
      { class: "settings-search-empty", role: "status", "data-testid": "settings-search-empty" },
      settingsText("search.noResults"),
    );
    searchEmpty.hidden = true;
    const searchBox = searchInput;
    searchBox.addEventListener("input", () => setQuery(searchBox.value), {
      signal: disposable.signal,
    });
    searchBox.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // An IME composition owns its keys (Enter commits, Escape cancels).
        if (isImeCommit(e)) {
          // Keep the page's Escape-to-close from seeing the IME's key.
          e.stopPropagation();
          return;
        }
        if (e.key === "Escape" && !isImeCommit(e) && searchBox.value !== "") {
          // The first Escape only clears; the next one closes the panel.
          e.preventDefault();
          e.stopPropagation();
          clearSearch();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
          e.preventDefault();
          if (e.key === "Enter" && query === "") return;
          enterTabs(e.key === "ArrowUp" ? "last" : "first");
        }
      },
      { signal: disposable.signal },
    );
    searchClear.addEventListener(
      "click",
      () => {
        clearSearch();
        searchBox.focus();
      },
      { signal: disposable.signal },
    );
    appendChildren(searchWrap, searchBox, searchClear);
    sidebar.appendChild(searchWrap);
    sidebar.appendChild(searchEmpty);

    // User profile section at top of sidebar
    const user = authStore.getState().user;
    const profileSection = createElement("div", { class: "settings-sidebar-profile" });
    // Show the uploaded avatar image, not only the initial, matching every
    // other identity surface (F24).
    const buildAvatar = (u: typeof user): HTMLDivElement =>
      createAvatarElement(
        {
          username: u?.username ?? "U",
          displayName: u?.display_name ?? null,
          avatar: u?.avatar ?? null,
        },
        { className: "settings-sidebar-avatar" },
      );
    let avatarEl = buildAvatar(user);
    const profileInfo = createElement("div", {});
    const profileName = createElement(
      "div",
      { class: "settings-sidebar-name" },
      user?.username ?? settingsText("common.unknown"),
    );
    const editProfileLink = createElement(
      "div",
      { class: "settings-sidebar-edit" },
      settingsText("shell.editProfile"),
    );
    if (authenticated) {
      editProfileLink.addEventListener(
        "click",
        () => {
          clearSearch();
          setActiveTab(ACCOUNT);
        },
        { signal: disposable.signal },
      );
    } else {
      editProfileLink.style.display = "none";
    }
    appendChildren(profileInfo, profileName, editProfileLink);
    appendChildren(profileSection, avatarEl, profileInfo);
    sidebar.appendChild(profileSection);

    // Keep the sidebar identity in step with the store — renaming yourself or
    // changing your avatar on the Account tab used to leave the old one
    // sitting here until restart.
    unsubAuth = authStore.subscribeSelector(
      (s) => s.user,
      (u) => {
        profileName.textContent = u?.username ?? settingsText("common.unknown");
        const next = buildAvatar(u);
        avatarEl.replaceWith(next);
        avatarEl = next;
      },
    );

    // "User Settings" category — only Account belongs here (hidden when not authenticated)
    if (authenticated) {
      userSettingsCat = createElement(
        "div",
        { class: "settings-cat" },
        settingsText("shell.userSettings"),
      );
      sidebar.appendChild(userSettingsCat);

      const accountBtn = createElement("button", {
        class: `settings-nav-item${activeTab === ACCOUNT ? " active" : ""}`,
        id: tabId(ACCOUNT),
        role: "tab",
        "aria-selected": activeTab === ACCOUNT ? "true" : "false",
        tabindex: activeTab === ACCOUNT ? "0" : "-1",
      });
      accountBtn.prepend(createIcon(TAB_ICONS[ACCOUNT], 18));
      accountBtn.appendChild(document.createTextNode(settingsText("tabs.account")));
      accountBtn.addEventListener("click", () => setActiveTab(ACCOUNT), {
        signal: disposable.signal,
      });
      tabButtons.set(ACCOUNT, accountBtn);
      sidebar.appendChild(accountBtn);

      if (options.safetyTab !== undefined) {
        const safetyBtn = createElement("button", {
          class: "settings-nav-item",
          id: tabId(SAFETY),
          role: "tab",
          "aria-selected": "false",
          tabindex: "-1",
        });
        safetyBtn.prepend(createIcon(TAB_ICONS[SAFETY], 18));
        safetyBtn.appendChild(document.createTextNode(tabLabel(SAFETY)));
        safetyBtn.addEventListener("click", () => setActiveTab(SAFETY), {
          signal: disposable.signal,
        });
        tabButtons.set(SAFETY, safetyBtn);
        sidebar.appendChild(safetyBtn);
      }
    }

    // "App Settings" category — remaining tabs
    appSettingsCat = createElement(
      "div",
      { class: "settings-cat" },
      settingsText("shell.appSettings"),
    );
    sidebar.appendChild(appSettingsCat);

    const appTabs = (Object.keys(TAB_LABEL_KEYS) as TabName[]).filter(
      (name) => name !== ACCOUNT && name !== SAFETY,
    );
    for (const name of appTabs) {
      const btn = createElement("button", {
        class: `settings-nav-item${name === activeTab ? " active" : ""}`,
        id: tabId(name),
        role: "tab",
        "aria-selected": name === activeTab ? "true" : "false",
        tabindex: name === activeTab ? "0" : "-1",
      });
      btn.prepend(createIcon(TAB_ICONS[name], 18));
      btn.appendChild(document.createTextNode(tabLabel(name)));
      if (name === ABOUT) {
        // A dot while the update check has a newer version on offer.
        const dot = createElement("span", { class: "settings-nav-dot" });
        dot.appendChild(
          createElement("span", { class: "sr-only" }, settingsText("tabs.aboutUpdate")),
        );
        unsubUpdate = subscribeAvailableUpdate((update) => {
          if (update === null) dot.remove();
          else btn.appendChild(dot);
        });
      }
      btn.addEventListener("click", () => setActiveTab(name), { signal: disposable.signal });
      tabButtons.set(name, btn);
      sidebar.appendChild(btn);
    }

    if (authenticated) {
      // Separator + Log Out at sidebar bottom
      const logoutWrap = createElement("div", { class: "settings-sidebar-logout" });
      const logoutSep = createElement("div", { class: "settings-sep" });
      const logoutBtn = createElement(
        "button",
        { class: "settings-nav-item danger" },
        settingsText("shell.logOut"),
      );
      logoutBtn.addEventListener(
        "click",
        () => {
          closeLogoutPrompt =
            confirmLogout({
              signal: disposable.signal,
              onConfirm: () => options.onLogout(),
              onClosed: () => {
                closeLogoutPrompt = null;
              },
              fallbackFocus: () => logoutBtn,
              container: root ?? undefined,
            }) ?? closeLogoutPrompt;
        },
        { signal: disposable.signal },
      );
      appendChildren(logoutWrap, logoutSep, logoutBtn);
      sidebar.appendChild(logoutWrap);
    }

    // The app version, small and muted at the very bottom of the nav. Read
    // lazily: a host that reports none leaves the nav as it was.
    const versionEl = createElement("div", { class: "settings-sidebar-version" });
    if (!authenticated) versionEl.classList.add("solo");
    void readAppVersion().then((version) => {
      if (version === null || disposable.signal.aborted) return;
      versionEl.textContent = settingsText("shell.version", { version });
      sidebar.appendChild(versionEl);
    });

    // Page title (h1) at top of content area — created here, inserted in renderActiveTab
    pageTitle = createElement("h1", {}, tabLabel(activeTab));

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
    closeBtn.addEventListener("click", requestClose, { signal: disposable.signal });
    const escLabel = createElement(
      "div",
      { class: "settings-esc-label" },
      settingsText("shell.esc"),
    );
    appendChildren(closeWrap, closeBtn, escLabel);

    // Escape key
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // The Log Out prompt owns Escape while it is open.
        if (
          e.key === "Escape" &&
          !isImeCommit(e) &&
          closeLogoutPrompt === null &&
          root?.classList.contains("open")
        ) {
          requestClose();
        } else if (
          closeLogoutPrompt === null &&
          root?.classList.contains("open") === true &&
          (e.ctrlKey || e.metaKey) &&
          !e.shiftKey &&
          !e.altKey &&
          e.key.toLowerCase() === "f"
        ) {
          // The page's Ctrl+F (message search) stands down while a dialog is up.
          e.preventDefault();
          searchInput?.focus();
          searchInput?.select();
        }
      },
      { signal: disposable.signal },
    );

    // Inner panel (Discord-style centered card)
    panel = createElement("div", { class: "settings-panel" });
    applyDialogSemantics(panel, { label: settingsText("shell.title") });
    // Arming the trap while hidden is safe: Tab can't land inside a
    // display:none panel, so the handler only fires while the overlay is open.
    trapFocus(panel, disposable.signal);
    appendChildren(panel, sidebar, contentArea, closeWrap);

    // Click backdrop (outside panel) to close
    closeOnBackdropClick(root, () => requestClose(), disposable.signal);

    root.appendChild(panel);
    // Don't build the active tab while the overlay is closed: its
    // builders issue REST reads (sessions, TOTP and recovery-kit status) that
    // are wasted work until the panel is actually shown. The first open
    // rebuilds via show() → !contentLive, so its data is as fresh as any later
    // open's.
    contentLive = uiStore.getState().settingsOpen;
    if (contentLive) renderActiveTab();

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

    // A tab requested while the panel is already open (show() only runs on the
    // closed-to-open transition). Each request bumps `settingsTabSeq`, so a
    // repeat of the same tab is heard too.
    unsubTabRequest = uiStore.subscribeSelector(
      (s) => s.settingsTabSeq,
      () => {
        if (root?.classList.contains("open") === true) applyRequestedTab();
      },
    );

    // Attach before syncing initial state: show() moves focus into the panel
    // via focusDialog(), and .focus() on a still-detached subtree is a
    // silent no-op. Callers that mount while settingsOpen is already true
    // (e.g. ConnectPage's lazy first-open path) would otherwise get a
    // visible overlay whose focus trap never actually captures focus.
    container.appendChild(root);

    // Sync initial state
    if (uiStore.getState().settingsOpen) {
      show();
    }
  }

  function destroy(): void {
    closeLogoutPrompt?.();
    closeLogoutPrompt = null;
    disposable.destroy();
    if (unsubUi !== null) {
      unsubUi();
      unsubUi = null;
    }
    unsubTabRequest?.();
    unsubTabRequest = null;
    unsubUpdate?.();
    unsubUpdate = null;
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
    searchInput = null;
    searchClear = null;
    searchEmpty = null;
    userSettingsCat = null;
    appSettingsCat = null;
  }

  function open(): void {
    show();
  }

  function close(): void {
    hide();
  }

  return { mount, destroy, open, close };
}
