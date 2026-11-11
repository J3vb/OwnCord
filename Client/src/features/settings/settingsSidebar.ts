/**
 * The Settings overlay's sidebar: search box, identity block, tab buttons,
 * Log Out and the app version. It owns no overlay state; the overlay hands in
 * the callbacks it reacts with and keeps what comes back.
 */

import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { authStore } from "@stores/auth.store";
import { settingsText } from "../../i18n/settings";
import { createAvatarElement } from "../profiles/avatar";
import { resolveDisplayName } from "@lib/ui/avatar";
import { readAppVersion } from "../whats-new/appVersion";
import { subscribeAvailableUpdate } from "../updates/availableUpdate";
import { isAndroidApp } from "../voice/native/platform";
import {
  ABOUT,
  ACCOUNT,
  KEYBINDS,
  MY_UPLOADS,
  SAFETY,
  TAB_ICONS,
  TAB_LABEL_KEYS,
  tabId,
  tabLabel,
} from "./settingsTabs";
import type { TabName } from "./settingsTabs";

export interface SidebarDeps {
  readonly signal: AbortSignal;
  readonly authenticated: boolean;
  readonly hasSafetyTab: boolean;
  readonly hasMyUploadsTab: boolean;
  readonly tabButtons: Map<TabName, HTMLButtonElement>;
  readonly getActiveTab: () => TabName;
  readonly getQuery: () => string;
  readonly visibleTabs: () => TabName[];
  readonly setActiveTab: (tab: TabName) => void;
  readonly openSection: (tab: TabName) => void;
  readonly setQuery: (raw: string) => void;
  readonly clearSearch: () => void;
  readonly enterTabs: (pick: "first" | "last") => TabName | null;
  /** Open the profile editor when the Account tab is the one on screen. */
  readonly revealProfileEditor: () => void;
  /** The Log Out button was pressed. */
  readonly onLogoutClick: (logoutBtn: HTMLButtonElement) => void;
}

export interface SidebarParts {
  readonly sidebar: HTMLDivElement;
  readonly searchInput: HTMLInputElement;
  readonly searchClear: HTMLButtonElement;
  readonly searchEmpty: HTMLElement;
  readonly userSettingsCat: HTMLElement | null;
  readonly appSettingsCat: HTMLElement;
  readonly unsubAuth: () => void;
  readonly unsubUpdate: (() => void) | null;
}

type SidebarUser = ReturnType<typeof authStore.getState>["user"];

// i18n-exempt: KeyboardEvent.key values
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** Index of the tab an arrow or Home/End key moves to, wrapping at both ends. */
function nextTabIndex(key: string, current: number, count: number): number {
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  return count - 1;
}

/**
 * Arrow-key navigation between tabs, activate-on-focus (the simpler
 * conformant flavor of the WAI-ARIA tabs pattern). Vertical list, so only
 * Up/Down move; Home/End jump to the edges; both directions wrap.
 */
function onSidebarKeydown(e: KeyboardEvent, deps: SidebarDeps): void {
  if (!NAV_KEYS.has(e.key)) return;
  const order = deps.visibleTabs();
  const current = order.findIndex((name) => deps.tabButtons.get(name) === e.target);
  if (current === -1) return; // e.g. the Log Out button — not a tab
  e.preventDefault();
  const name = order[nextTabIndex(e.key, current, order.length)]!;
  deps.setActiveTab(name);
  // A blocked switch keeps focus on the selected tab (activate-on-focus).
  if (deps.getActiveTab() === name) deps.tabButtons.get(name)?.focus();
}

function onSearchKeydown(e: KeyboardEvent, searchBox: HTMLInputElement, deps: SidebarDeps): void {
  // An IME composition owns its keys (Enter commits, Escape cancels).
  if (isImeCommit(e)) {
    // Keep the page's Escape-to-close from seeing the IME's key.
    e.stopPropagation();
    return;
  }
  if (e.key === "Escape" && searchBox.value !== "") {
    // The first Escape only clears; the next one closes the panel.
    e.preventDefault();
    e.stopPropagation();
    deps.clearSearch();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
  e.preventDefault();
  if (e.key === "Enter" && deps.getQuery() === "") return;
  const picked = deps.enterTabs(e.key === "ArrowUp" ? "last" : "first");
  if (e.key === "Enter" && picked !== null) deps.openSection(picked);
}

/** Search box above everything else in the nav. */
function buildSearch(
  deps: SidebarDeps,
): Pick<SidebarParts, "searchInput" | "searchClear" | "searchEmpty"> & { wrap: HTMLDivElement } {
  const wrap = createElement("div", { class: "settings-search" });
  const searchInput = createElement("input", {
    class: "settings-search-input",
    type: "text",
    placeholder: settingsText("search.placeholder"),
    "aria-label": settingsText("search.label"),
    autocomplete: "off",
    spellcheck: "false",
    "data-testid": "settings-search",
  });
  const searchClear = createElement("button", {
    class: "settings-search-clear",
    type: "button",
    "aria-label": settingsText("search.clear"),
    "data-testid": "settings-search-clear",
  });
  searchClear.hidden = true;
  searchClear.appendChild(createIcon("x", 14));
  const searchEmpty = createElement(
    "div",
    { class: "settings-search-empty", role: "status", "data-testid": "settings-search-empty" },
    settingsText("search.noResults"),
  );
  searchEmpty.hidden = true;
  searchInput.addEventListener("input", () => deps.setQuery(searchInput.value), {
    signal: deps.signal,
  });
  searchInput.addEventListener(
    "keydown",
    (e: KeyboardEvent) => onSearchKeydown(e, searchInput, deps),
    {
      signal: deps.signal,
    },
  );
  searchClear.addEventListener(
    "click",
    () => {
      deps.clearSearch();
      searchInput.focus();
    },
    { signal: deps.signal },
  );
  appendChildren(wrap, searchInput, searchClear);
  return { wrap, searchInput, searchClear, searchEmpty };
}

/**
 * Show the uploaded avatar image, not only the initial, matching every
 * other identity surface.
 */
function buildAvatar(u: SidebarUser): HTMLDivElement {
  return createAvatarElement(
    {
      username: u?.username ?? "U",
      displayName: u?.display_name ?? null,
      avatar: u?.avatar ?? null,
    },
    { className: "settings-sidebar-avatar" },
  );
}

/** The identity block; it follows the auth store for the overlay's lifetime. */
function buildProfile(sidebar: HTMLDivElement, deps: SidebarDeps): { unsubAuth: () => void } {
  const user = authStore.getState().user;
  const profileSection = createElement("div", { class: "settings-sidebar-profile" });
  let avatarEl = buildAvatar(user);
  const profileInfo = createElement("div", { class: "settings-sidebar-identity" });
  // The display name like every other identity surface, with @username
  // under it only when the two differ.
  const profileName = createElement("div", { class: "settings-sidebar-name" });
  const profileHandle = createElement("div", { class: "settings-sidebar-handle" });
  const paintIdentity = (u: SidebarUser): void => {
    const username = u?.username ?? settingsText("common.unknown");
    const shown = resolveDisplayName({ username, displayName: u?.display_name ?? null });
    profileName.textContent = shown;
    profileHandle.textContent = `@${username}`;
    profileHandle.hidden = shown === username;
  };
  paintIdentity(user);
  const editProfileLink = createElement(
    "button",
    { class: "settings-sidebar-edit", type: "button" },
    settingsText("shell.editProfile"),
  );
  if (deps.authenticated) {
    editProfileLink.addEventListener(
      "click",
      () => {
        deps.clearSearch();
        deps.openSection(ACCOUNT);
        deps.revealProfileEditor();
      },
      { signal: deps.signal },
    );
  } else {
    editProfileLink.style.display = "none";
  }
  appendChildren(profileInfo, profileName, profileHandle, editProfileLink);
  appendChildren(profileSection, avatarEl, profileInfo);
  sidebar.appendChild(profileSection);

  // Keep the sidebar identity in step with the store — renaming yourself or
  // changing your avatar on the Account tab used to leave the old one
  // sitting here until restart.
  const unsubAuth = authStore.subscribeSelector(
    (s) => s.user,
    (u) => {
      paintIdentity(u);
      const next = buildAvatar(u);
      avatarEl.replaceWith(next);
      avatarEl = next;
    },
  );
  return { unsubAuth };
}

/** One tab button: icon, label, roving tabindex and click-to-open. */
function buildNavButton(name: TabName, deps: SidebarDeps): HTMLButtonElement {
  const isActive = name === deps.getActiveTab();
  const btn = createElement("button", {
    class: `settings-nav-item${isActive ? " active" : ""}`,
    id: tabId(name),
    role: "tab",
    "aria-selected": isActive ? "true" : "false",
    tabindex: isActive ? "0" : "-1",
  });
  btn.prepend(createIcon(TAB_ICONS[name], 18));
  btn.appendChild(document.createTextNode(tabLabel(name)));
  return btn;
}

function addNavButton(
  sidebar: HTMLDivElement,
  name: TabName,
  deps: SidebarDeps,
  btn: HTMLButtonElement = buildNavButton(name, deps),
): HTMLButtonElement {
  btn.addEventListener("click", () => deps.openSection(name), { signal: deps.signal });
  deps.tabButtons.set(name, btn);
  sidebar.appendChild(btn);
  return btn;
}

/** The "User Settings" heading and the tabs that belong under it. */
function buildUserTabs(sidebar: HTMLDivElement, deps: SidebarDeps): HTMLElement {
  const cat = createElement("div", { class: "settings-cat" }, settingsText("shell.userSettings"));
  sidebar.appendChild(cat);
  addNavButton(sidebar, ACCOUNT, deps);
  if (deps.hasSafetyTab) addNavButton(sidebar, SAFETY, deps);
  if (deps.hasMyUploadsTab) addNavButton(sidebar, MY_UPLOADS, deps);
  return cat;
}

/** A dot on the About tab while the update check has a newer version on offer. */
function watchUpdateDot(btn: HTMLButtonElement): () => void {
  const dot = createElement("span", { class: "settings-nav-dot" });
  dot.appendChild(createElement("span", { class: "sr-only" }, settingsText("tabs.aboutUpdate")));
  return subscribeAvailableUpdate((update) => {
    if (update === null) dot.remove();
    else btn.appendChild(dot);
  });
}

/** The tabs under "App Settings". The Android app has no keybinds to set. */
function appTabNames(): TabName[] {
  return (Object.keys(TAB_LABEL_KEYS) as TabName[]).filter(
    (name) =>
      name !== ACCOUNT &&
      name !== SAFETY &&
      name !== MY_UPLOADS &&
      !(name === KEYBINDS && isAndroidApp()),
  );
}

function buildAppTabs(
  sidebar: HTMLDivElement,
  deps: SidebarDeps,
): { cat: HTMLElement; unsubUpdate: (() => void) | null } {
  const cat = createElement("div", { class: "settings-cat" }, settingsText("shell.appSettings"));
  sidebar.appendChild(cat);
  let unsubUpdate: (() => void) | null = null;
  for (const name of appTabNames()) {
    const btn = buildNavButton(name, deps);
    if (name === ABOUT) unsubUpdate = watchUpdateDot(btn);
    addNavButton(sidebar, name, deps, btn);
  }
  return { cat, unsubUpdate };
}

/** Separator + Log Out at the sidebar bottom. */
function buildLogout(sidebar: HTMLDivElement, deps: SidebarDeps): void {
  const logoutWrap = createElement("div", { class: "settings-sidebar-logout" });
  const logoutSep = createElement("div", { class: "settings-sep" });
  const logoutBtn = createElement(
    "button",
    { class: "settings-nav-item danger" },
    settingsText("shell.logOut"),
  );
  logoutBtn.addEventListener("click", () => deps.onLogoutClick(logoutBtn), {
    signal: deps.signal,
  });
  appendChildren(logoutWrap, logoutSep, logoutBtn);
  sidebar.appendChild(logoutWrap);
}

/**
 * The app version, small and muted at the very bottom of the nav. Read
 * lazily: a host that reports none leaves the nav as it was.
 */
function addVersion(sidebar: HTMLDivElement, deps: SidebarDeps): void {
  const versionEl = createElement("div", { class: "settings-sidebar-version" });
  if (!deps.authenticated) versionEl.classList.add("solo");
  void readAppVersion().then((version) => {
    if (version === null || deps.signal.aborted) return;
    versionEl.textContent = settingsText("shell.version", { version });
    sidebar.appendChild(versionEl);
  });
}

/**
 * Build the whole sidebar. It doubles as the tablist: the profile block,
 * category headings and the Log Out button also live in here, and a tablist
 * should own only tabs — but moving them out would change the structure the
 * e2e selectors pin down, so the non-tab children stay as presentational
 * noise inside the tablist.
 */
export function buildSettingsSidebar(deps: SidebarDeps): SidebarParts {
  const sidebar = createElement("div", {
    class: "settings-sidebar",
    role: "tablist",
    "aria-orientation": "vertical",
    "aria-label": settingsText("shell.sections"),
  });
  sidebar.addEventListener("keydown", (e: KeyboardEvent) => onSidebarKeydown(e, deps), {
    signal: deps.signal,
  });

  const { wrap, searchInput, searchClear, searchEmpty } = buildSearch(deps);
  // The list's own heading, shown only on a phone where the list is a page;
  // CSS lifts it above the search box, which stays first in the tab order.
  const listTitle = createElement(
    "h2",
    { class: "settings-list-title", "aria-hidden": "true" },
    settingsText("shell.title"),
  );
  sidebar.appendChild(wrap);
  sidebar.appendChild(searchEmpty);
  sidebar.appendChild(listTitle);

  const { unsubAuth } = buildProfile(sidebar, deps);
  // "User Settings" category — only Account belongs here (hidden when not authenticated)
  const userSettingsCat = deps.authenticated ? buildUserTabs(sidebar, deps) : null;
  const { cat: appSettingsCat, unsubUpdate } = buildAppTabs(sidebar, deps);
  if (deps.authenticated) buildLogout(sidebar, deps);
  addVersion(sidebar, deps);

  return {
    sidebar,
    searchInput,
    searchClear,
    searchEmpty,
    userSettingsCat,
    appSettingsCat,
    unsubAuth,
    unsubUpdate,
  };
}
