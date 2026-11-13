/**
 * The call view's View menu: the view toggles, popping the call out and
 * showing the chat as named rows. A desktop opens it from one View button
 * beside the control bar, a phone from its round control in the bar.
 */
import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon, type IconName } from "@lib/icons";
import {
  showContextMenu,
  type ContextMenuItem,
  type ContextMenuSeparator,
} from "@lib/ui/contextMenu";
import { voiceText } from "../../../i18n/voice";
import { isAndroidApp } from "../native/platform";
import type { ViewToggle } from "./gridShared";
import type { GridState, GridApi } from "./gridState";

type ViewMenuRow = ContextMenuItem | ContextMenuSeparator;

/** The view toggles in menu order, the phone's and the desktop's alike. */
function toggleLabels(): readonly [ViewToggle, string, IconName][] {
  return [
    ["nonVideo", voiceText("grid.showNonVideo"), "user"],
    ["selfCamera", voiceText("grid.showMyCamera"), "square-user"],
    ["strip", voiceText("grid.showStrip"), "layout-grid"],
  ];
}

export function createGridViewMenu(st: GridState, api: GridApi) {
  /** Owns the open View menu, so it can close with the window it is in. */
  let menuOwner: Disposable | null = null;

  /** Close the View menu, if one is open. */
  function closeViewMenu(): void {
    menuOwner?.destroy();
    menuOwner = null;
  }
  st.gridListeners.addCleanup(closeViewMenu);

  /** Pop out, or bring the call back, and Show chat where `withChat` asks
   *  for it (a phone has its own Chat control). */
  function actionRows(withChat: boolean): ContextMenuItem[] {
    const rows: ContextMenuItem[] = [];
    // The Android app has one window, so there is nothing to pop out to.
    if (!isAndroidApp()) {
      rows.push({
        label: voiceText(st.callPop === null ? "grid.popOutCall" : "grid.popInCall"),
        icon: "external-link",
        testId: "view-menu-popout",
        onClick: () => {
          if (st.callPop === null) api.popOutCall();
          else api.closeCallPopout(true);
        },
      });
    }
    const showChat = st.callbacks.onExitGrid;
    // A popped-out call leaves the chat on show in the app window.
    if (withChat && showChat !== undefined && st.callPop === null) {
      rows.push({
        label: voiceText("grid.showChat"),
        icon: "message-square",
        testId: "view-menu-chat",
        onClick: () => {
          api.setFocusedTile(null);
          showChat();
        },
      });
    }
    return rows;
  }

  /** The rows as they stand now: each toggle checked while it is on. */
  function viewMenuRows(withChat: boolean): ViewMenuRow[] {
    const rows: ViewMenuRow[] = toggleLabels().map(([key, label, icon]) => ({
      label,
      icon,
      checked: st.viewOn[key],
      testId: `view-menu-${key}`,
      onClick: () => api.setView(key, !st.viewOn[key]),
    }));
    const actions = actionRows(withChat);
    if (actions.length > 0) rows.push({ separator: true }, ...actions);
    return rows;
  }

  /** Open the menu above `anchor`, in the grid's own window. */
  function openViewMenu(anchor: HTMLButtonElement, withChat: boolean): void {
    const rect = anchor.getBoundingClientRect();
    closeViewMenu();
    const owner = new Disposable();
    menuOwner = owner;
    anchor.setAttribute("aria-expanded", "true");
    showContextMenu({
      x: rect.left,
      y: rect.top,
      items: viewMenuRows(withChat),
      ariaLabel: voiceText("grid.viewOptions"),
      doc: api.doc(),
      restoreFocusTo: () => (anchor.isConnected ? anchor : null),
      onClosed: () => {
        anchor.setAttribute("aria-expanded", "false");
        if (menuOwner === owner) menuOwner = null;
      },
      signal: owner.signal,
    });
  }

  /** The desktop call view's View button, in its own corner bar. */
  function buildViewBar(): HTMLElement {
    const bar = createElement("div", { class: "video-grid__views" });
    const label = voiceText("grid.viewOptions");
    const btn = createElement("button", {
      type: "button",
      class: "video-grid__view-menu",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": label,
      title: label,
      "data-grid-control": "views",
    });
    btn.append(
      createIcon("layout-grid", 16),
      createElement("span", {}, voiceText("grid.view")),
      createIcon("chevron-up", 14),
    );
    btn.addEventListener("click", () => openViewMenu(btn, true));
    st.viewBtn = btn;
    bar.appendChild(btn);
    return bar;
  }

  return { buildViewBar, openViewMenu, closeViewMenu, viewMenuRows };
}
