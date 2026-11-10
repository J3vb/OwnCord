/** Small pieces of the Settings overlay's frame and its nav filtering. */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { settingsText } from "../../i18n/settings";
import { tabMatches } from "./settingsSearch";
import { ACCOUNT, SAFETY, tabLabel } from "./settingsTabs";
import type { TabName } from "./settingsTabs";

/**
 * With `isPhoneLayout()`, this matches the phone rules in settings.css: the
 * list and a section take turns on a narrow window, and on a phone of any
 * orientation.
 */
const PHONE_QUERY = "(max-width: 600px)";

/** The panel is laid out as pages: a narrow window, or a phone in any orientation. */
export function createPagedLayoutCheck(): () => boolean {
  const narrowWindow =
    typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
  return () => narrowWindow?.matches === true || isPhoneLayout();
}

/** Ctrl or Cmd plus F, with no other modifier. */
export function isFindShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
}

/** Close button wrapped with its ESC label. */
export function buildCloseWrap(onClose: () => void, signal: AbortSignal): HTMLDivElement {
  const closeWrap = createElement("div", { class: "settings-close-wrap" });
  const closeBtn = createElement("button", { class: "settings-close-btn" });
  closeBtn.appendChild(createIcon("x", 18));
  closeBtn.addEventListener("click", onClose, { signal });
  const escLabel = createElement("div", { class: "settings-esc-label" }, settingsText("shell.esc"));
  appendChildren(closeWrap, closeBtn, escLabel);
  return closeWrap;
}

/** The phone Back button. */
export function buildBackButton(onBack: () => void, signal: AbortSignal): HTMLButtonElement {
  const btn = createElement("button", {
    class: "settings-back-btn",
    type: "button",
    "aria-label": settingsText("shell.back"),
    "data-testid": "settings-back",
  });
  btn.appendChild(createIcon("chevron-left", 22));
  btn.addEventListener("click", onBack, { signal });
  return btn;
}

export interface NavFilterView {
  readonly tabButtons: ReadonlyMap<TabName, HTMLButtonElement>;
  readonly query: string;
  readonly userSettingsCat: HTMLElement | null;
  readonly appSettingsCat: HTMLElement | null;
  readonly searchEmpty: HTMLElement | null;
  readonly searchClear: HTMLButtonElement | null;
  readonly searchInput: HTMLInputElement | null;
  readonly visibleTabs: () => TabName[];
}

/** Hide the tabs (and headings) the query rules out; show the rest. */
export function paintNavFilter(view: NavFilterView): void {
  let any = false;
  for (const [name, btn] of view.tabButtons) {
    const match = tabMatches(name, tabLabel(name), view.query);
    btn.hidden = !match;
    any ||= match;
  }
  if (view.userSettingsCat !== null) {
    view.userSettingsCat.hidden = !view.visibleTabs().some((n) => n === ACCOUNT || n === SAFETY);
  }
  if (view.appSettingsCat !== null) {
    view.appSettingsCat.hidden = !view.visibleTabs().some((n) => n !== ACCOUNT && n !== SAFETY);
  }
  if (view.searchEmpty !== null) view.searchEmpty.hidden = any;
  if (view.searchClear !== null) view.searchClear.hidden = view.searchInput?.value === "";
}

/** Keep one tab in the page Tab order when the open one was filtered out. */
export function paintTabStops(
  tabButtons: ReadonlyMap<TabName, HTMLButtonElement>,
  activeTab: TabName,
  shown: readonly TabName[],
): void {
  const stop = tabButtons.get(activeTab)?.hidden === false ? activeTab : shown[0];
  for (const [name, btn] of tabButtons) btn.setAttribute("tabindex", name === stop ? "0" : "-1");
}
