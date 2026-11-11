/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Safety (once its feature ships), Appearance, Accessibility, Voice & Video, Text & Images, Notifications, Keybinds, Advanced, Logs, About.
 * Subscribes to uiStore for settingsOpen state.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { isDisplayed } from "@lib/ui/dialogOpen";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/ui/a11y";
import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { closeOnBackdropClick } from "@lib/ui/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import { uiStore } from "@stores/ui.store";
import { settingsText } from "../../i18n/settings";
import { openProfileEditor } from "./AccountProfile";
import { createVoiceAudioTab } from "./VoiceAudioTab";
import { createLogsTab } from "./LogsTab";
import { highlightMatches, normalizeQuery } from "./settingsSearch";
import { confirmLogout } from "./logoutConfirm";
import { buildSettingsSidebar } from "./settingsSidebar";
import { ACCOUNT, tabId, tabLabel } from "./settingsTabs";
import {
  buildBackButton,
  buildCloseWrap,
  createPagedLayoutCheck,
  isFindShortcut,
  paintNavFilter,
  paintTabStops,
} from "./settingsChrome";
import type { TabName } from "./settingsTabs";
import { createSecretHold, createUnsavedGuard } from "./settingsGuards";
import { createTabBuilders } from "./settingsTabBuilders";
import type { SettingsOverlayOptions } from "./settingsOverlayOptions";

export type { SettingsOverlayOptions } from "./settingsOverlayOptions";
export type { TabName } from "./settingsTabs";

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
  /** Store and update subscriptions, dropped together on destroy. */
  const unsubs: Array<() => void> = [];
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
  /** On a phone the panel shows either the section list or one open section. */
  let sectionOpen = false;
  let backBtn: HTMLButtonElement | null = null;
  const pagedLayout = createPagedLayoutCheck();

  // Stateful tabs — create via factory for proper cleanup on tab switch
  const logsTab = createLogsTab(() => activeTab, disposable.signal);
  const voiceTab = createVoiceAudioTab(disposable.signal);

  // ---- Guards: one-time secrets and unsaved edits -------------------------

  const secretHold = createSecretHold();
  const unsaved = createUnsavedGuard(disposable.signal, () => root ?? undefined);
  const { holdOpen } = secretHold;
  const { blockedByUnsaved } = unsaved;
  function requestClose(): void {
    if (secretHold.held() || blockedByUnsaved(requestClose)) return;
    options.onClose();
  }

  // ---- Tab content builders -------------------------------------------------

  const TAB_BUILDERS = createTabBuilders({
    options,
    holdOpen,
    setDirtyCheck: (isDirty) => unsaved.setDirtyCheck(isDirty),
    buildVoiceTab: (signal) => voiceTab.build(signal),
    buildLogsTab: (signal) => logsTab.build(signal),
    markSearchHits: () => markSearchHits(),
  });

  // ---- Core methods ---------------------------------------------------------

  function renderActiveTab(): void {
    if (contentArea === null) return;
    // Drop the previous build's listeners before replacing its DOM — see
    // the `renderOwner` comment above.
    renderOwner?.destroy();
    renderOwner = new Disposable();
    unsaved.setDirtyCheck(null);
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

  /** On the side-by-side layout the open page follows the filter, so hits
   *  highlight as you type; unsaved edits keep their tab. */
  function followFilter(): void {
    const first = visibleTabs()[0];
    if (first === undefined || tabButtons.get(activeTab)?.hidden !== true) return;
    if (pagedLayout() || unsaved.isDirty()) return;
    setActiveTab(first);
  }

  /** Hide the tabs the query rules out, follow the filter, fix the tab stop. */
  function applySearch(): void {
    paintNavFilter({
      tabButtons,
      query,
      userSettingsCat,
      appSettingsCat,
      searchEmpty,
      searchClear,
      searchInput,
      visibleTabs,
    });
    followFilter();
    paintTabStops(tabButtons, activeTab, visibleTabs());
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
  /** Returns the tab it picked, or null when the query matched none or a
   *  pending recovery secret held the switch. */
  function enterTabs(pick: "first" | "last"): TabName | null {
    if (query === "") {
      // Nothing to pick from: just move onto the open tab.
      const btn = tabButtons.get(activeTab);
      if (btn?.hidden === false) btn.focus();
      return null;
    }
    const shown = visibleTabs();
    const name = pick === "first" ? shown[0] : shown[shown.length - 1];
    if (name === undefined) return null;
    setActiveTab(name);
    if (activeTab !== name) return null;
    if (!secretHold.held()) tabButtons.get(name)?.focus();
    return name;
  }

  /** Release resources held by the tab currently on screen. */
  function cleanupActiveTab(): void {
    if (activeTab === "Voice & Video") voiceTab.cleanup();
    // The Logs tab keeps a live log listener pointed at its (now discarded)
    // list element — drop it so it isn't re-rendering a detached tree.
    if (activeTab === "Logs") logsTab.cleanup();
  }

  function setActiveTab(tab: TabName): void {
    if (tab === activeTab || secretHold.held()) return;
    if (blockedByUnsaved(() => setActiveTab(tab))) return;
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

  /** Phone only: swap between the section list and the open section. */
  function setSectionOpen(on: boolean): void {
    sectionOpen = on;
    panel?.classList.toggle("settings-panel--section", on);
  }

  /** A tab picked by tap or Enter: on a phone that also opens its section. */
  function openSection(tab: TabName): void {
    if (tab !== activeTab && blockedByUnsaved(() => openSection(tab))) return;
    setActiveTab(tab);
    if (activeTab !== tab) return;
    setSectionOpen(true);
    if (!pagedLayout()) return;
    contentArea?.scrollTo?.({ top: 0 });
    // The list (and the tab that had focus) is hidden now: focus moves to Back.
    backBtn?.focus();
  }

  /** Phone Back: from a section to the list, focus on the section it left. */
  function backToList(): void {
    setSectionOpen(false);
    tabButtons.get(activeTab)?.focus();
  }

  /** Another surface asked for a tab (a Q4 notice links to Safety, the server
   *  menu to Notifications). A tab that is not shown here is ignored. */
  function applyRequestedTab(): void {
    const raw = uiStore.getState().settingsTab;
    // "Profile" is the Account tab with its editor open, done once the tab is
    // built and focus has moved in (revealRequestedEditor).
    const requested = raw === "Profile" ? ACCOUNT : raw;
    if (requested !== null && requested !== activeTab && tabButtons.has(requested)) {
      // A hidden requested tab would strand the only tab stop: reset search.
      clearSearch();
      setActiveTab(requested);
    }
    if (requested !== null && requested === activeTab) setSectionOpen(true);
  }

  /** Open the profile editor when the last request asked for it. */
  function revealRequestedEditor(): void {
    if (uiStore.getState().settingsTab !== "Profile" || activeTab !== ACCOUNT) return;
    if (contentArea !== null) openProfileEditor(contentArea);
  }

  function show(): void {
    const wasOpen = root?.classList.contains("open") ?? false;
    root?.classList.add("open");
    // A phone opens on the section list unless another surface asked for a tab.
    if (!wasOpen) setSectionOpen(false);
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
    revealRequestedEditor();
  }

  /** A dialog sits inside the panel: the Log Out prompt or one a tab opened. */
  function promptOpen(): boolean {
    return (
      closeLogoutPrompt !== null ||
      unsaved.promptOpen() ||
      root?.querySelector(".modal-overlay") != null
    );
  }

  function hide(): void {
    // A Log Out prompt left open must not outlive the panel it belongs to.
    closeLogoutPrompt?.();
    unsaved.closePrompt();
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

  /** The Log Out prompt, kept so a close or teardown can dismiss it. */
  function openLogoutPrompt(logoutBtn: HTMLButtonElement): void {
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
  }

  /** The profile editor, when the Account tab is the one on screen. */
  function revealProfileEditorOnAccount(): void {
    if (activeTab === ACCOUNT && contentArea !== null) openProfileEditor(contentArea);
  }

  /** Escape closes (or backs out of a phone section); Ctrl+F focuses search. */
  function onDocumentKeydown(e: KeyboardEvent): void {
    const isEscape = e.key === "Escape" && !isImeCommit(e);
    if (!isEscape && !isFindShortcut(e)) return;
    // A prompt mounted in the panel (Log Out, a tab's confirmation) owns Escape while it is open.
    if (promptOpen() || root?.classList.contains("open") !== true) return;
    if (isEscape) {
      // On a phone, Back leaves the open section before it closes Settings.
      if (sectionOpen && pagedLayout()) backToList();
      else requestClose();
      return;
    }
    // The page's Ctrl+F (message search) stands down while a dialog is up.
    e.preventDefault();
    searchInput?.focus();
    searchInput?.select();
  }

  function buildSidebar(): HTMLDivElement {
    const parts = buildSettingsSidebar({
      signal: disposable.signal,
      authenticated,
      hasSafetyTab: options.safetyTab !== undefined,
      hasMyUploadsTab: options.myUploadsTab !== undefined,
      tabButtons,
      getActiveTab: () => activeTab,
      getQuery: () => query,
      visibleTabs,
      setActiveTab,
      openSection,
      setQuery,
      clearSearch,
      enterTabs,
      revealProfileEditor: revealProfileEditorOnAccount,
      onLogoutClick: openLogoutPrompt,
    });
    searchInput = parts.searchInput;
    searchClear = parts.searchClear;
    searchEmpty = parts.searchEmpty;
    userSettingsCat = parts.userSettingsCat;
    appSettingsCat = parts.appSettingsCat;
    unsubs.push(parts.unsubAuth);
    if (parts.unsubUpdate !== null) unsubs.push(parts.unsubUpdate);
    return parts.sidebar;
  }

  function subscribeUiStore(): void {
    const unsubUi = uiStore.subscribeSelector(
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
    const unsubTabRequest = uiStore.subscribeSelector(
      (s) => s.settingsTabSeq,
      () => {
        if (root?.classList.contains("open") !== true) return;
        applyRequestedTab();
        revealRequestedEditor();
      },
    );
    unsubs.push(unsubUi, unsubTabRequest);
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "settings-overlay", "data-testid": "settings-overlay" });
    const sidebar = buildSidebar();

    // Page title (h1) at top of content area — created here, inserted in renderActiveTab
    pageTitle = createElement("h1", {}, tabLabel(activeTab));

    // Content — the single tabpanel, renamed per switch via aria-labelledby
    contentArea = createElement("div", {
      class: "settings-content",
      role: "tabpanel",
      "aria-labelledby": tabId(activeTab),
    });

    const closeWrap = buildCloseWrap(requestClose, disposable.signal);
    backBtn = buildBackButton(backToList, disposable.signal);

    // Escape key
    document.addEventListener("keydown", onDocumentKeydown, { signal: disposable.signal });

    // Inner panel (Discord-style centered card)
    panel = createElement("div", { class: "settings-panel" });
    applyDialogSemantics(panel, { label: settingsText("shell.title") });
    // Arming the trap while hidden is safe: Tab can't land inside a
    // display:none panel, so the handler only fires while the overlay is open.
    trapFocus(panel, disposable.signal);
    appendChildren(panel, sidebar, contentArea, closeWrap, backBtn);

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
    subscribeUiStore();

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
    unsaved.closePrompt(true);
    disposable.destroy();
    for (const unsub of unsubs.splice(0)) unsub();
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
    backBtn = null;
    searchInput = null;
    searchClear = null;
    searchEmpty = null;
    userSettingsCat = null;
    appSettingsCat = null;
  }

  return { mount, destroy, open: show, close: hide };
}
