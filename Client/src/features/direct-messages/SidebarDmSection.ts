/**
 * SidebarDmSection — the embedded DM preview section that sits above channels
 * in "channels" mode. Shows the top 3 DM conversations, an unread badge,
 * a "View all messages" button, and collapse toggle.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { atEachMidnight, formatBadgeCount } from "@lib/text/formatting";
import { reconcileChildren } from "@lib/net/reconcile";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";
import { dmStore } from "@stores/dm.store";
import { totalDmUnread } from "@lib/dmUnread";
import type { DmChannel } from "@stores/dm.store";
import {
  DM_SECTION_COLLAPSED_KEY,
  isCategoryCollapsed,
  setSidebarMode,
  toggleCategory,
} from "@stores/ui.store";
import { trackCurrentView } from "../navigation/contentView";
import type { CountSource } from "../navigation/destinations";
import { navigationText } from "../../i18n/navigation";
import { shellText } from "../../i18n/shell";
import type { DmMenuActions } from "./dmContextMenu";
import { buildDmRow, createLeavePrompt, dmRowSignature, watchDmListInputs } from "./sidebarDmRow";
import { onPrefChange } from "@lib/prefs/preferences";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarDmSectionOptions {
  /** Called when the user clicks a DM entry to open that conversation. */
  readonly onSelectDm: (dmChannel: DmChannel) => void;
  /** Called when the user clicks the "+" button to create a new DM. */
  readonly onNewDm: () => void;
  /** Pending Message Requests. Badged apart from unread, never added to it. */
  readonly pendingRequests?: CountSource;
  /**
   * Open the Message Requests inbox. With it, pending requests also get their
   * own "Message Requests (N)" row in the preview list: a first contact has no
   * DM row yet, so without one the reader has nothing to click but the badge.
   */
  readonly onOpenRequests?: (opener: HTMLElement) => void;
  /** The row context menu's actions: the same set DmSidebar's rows offer. */
  readonly menu?: DmMenuActions;
}

export interface SidebarDmSectionResult {
  /** The root element to insert into the DOM. */
  readonly element: HTMLDivElement;
  /** Re-render the DM list from current store state. */
  readonly update: () => void;
  /** Clean up store subscriptions. */
  readonly destroy: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSidebarDmSection(opts: SidebarDmSectionOptions): SidebarDmSectionResult {
  const unsubs: Array<() => void> = [];
  const listLifecycle = new Disposable();
  // Each row's menu listeners die with the row, not with the section.
  const rowOwners = new Map<Element, Disposable>();
  const { confirmLeave, closeIfGone } = createLeavePrompt(listLifecycle.signal);

  // --- Root container ---
  const dmSection = createElement("div", { class: "sidebar-dm-section" });

  // --- Header ---
  // The header contains its own buttons (the "+" and the requests badge), so it
  // stays a plain div with a mouse click handler; the arrow is the keyboard
  // collapse control, a real <button> named by the heading, as on the channel
  // categories.
  const dmHeader = createElement("div", { class: "category" });
  const dmLabelEl = createElement(
    "span",
    { class: "category-name", id: "sidebar-dm-heading" },
    shellText("dm.heading"),
  );
  const dmArrow = createElement(
    "button",
    {
      type: "button",
      class: "category-arrow",
      "aria-expanded": "true",
      "aria-labelledby": "sidebar-dm-heading",
    },
    "\u25BC",
  );
  const dmUnreadBadge = createElement("span", { class: "dm-header-unread-badge" });
  const dmAddBtn = createElement(
    "button",
    { class: "category-add-btn", title: shellText("dm.new") },
    "+",
  );
  dmAddBtn.style.opacity = "1";
  appendChildren(dmHeader, dmArrow, dmLabelEl, dmUnreadBadge);

  // Its own badge, not a share of the unread one: a request is not a message
  // the reader has, and it never raises the unread or mention totals. It is a
  // button into DM mode, where "Message Requests (N)" sits: with no DM rows
  // and no "View all", it is a first-contact reader's only way in.
  const pending = opts.pendingRequests;
  if (pending !== undefined) {
    const requestsBadge = createElement("button", {
      type: "button",
      class: "dm-header-requests-badge",
      "data-testid": "dm-requests-badge",
    });
    requestsBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      setSidebarMode("dms");
    });
    const requestsCount = createElement("span", { "aria-hidden": "true" });
    const requestsLabel = createElement("span", { class: "sr-only" });
    appendChildren(requestsBadge, requestsCount, requestsLabel);
    const renderRequests = (): void => {
      const count = pending.get();
      setText(requestsCount, String(count));
      setText(requestsLabel, navigationText("requests.badge", { count }));
      requestsBadge.style.display = count > 0 ? "" : "none";
    };
    renderRequests();
    unsubs.push(pending.subscribe(renderRequests));
    dmHeader.appendChild(requestsBadge);
  }
  dmHeader.appendChild(dmAddBtn);
  dmSection.appendChild(dmHeader);

  // --- DM list ---
  let dmCollapsed = isCategoryCollapsed(DM_SECTION_COLLAPSED_KEY);

  // "Message Requests (N)" above the conversations, while any are pending.
  let renderRequestsRow: (() => void) | undefined;
  const onOpenRequests = opts.onOpenRequests;
  if (pending !== undefined && onOpenRequests !== undefined) {
    const requestsRow = createElement("button", {
      type: "button",
      class: "sidebar-dm-view-all dm-requests-entry",
      "data-testid": "dm-section-requests-entry",
    });
    requestsRow.addEventListener("click", () => {
      onOpenRequests(requestsRow);
    });
    renderRequestsRow = (): void => {
      const count = pending.get();
      setText(requestsRow, navigationText("requests.entry", { count }));
      requestsRow.style.display = count > 0 && !dmCollapsed ? "" : "none";
    };
    renderRequestsRow();
    unsubs.push(pending.subscribe(renderRequestsRow));
    unsubs.push(trackCurrentView(requestsRow, "requests"));
    dmSection.appendChild(requestsRow);
  }

  const dmList = createElement("div", { class: "category-channels sidebar-dm-list" });

  // --- "View All" button ---
  const viewAllBtn = createElement(
    "button",
    {
      class: "sidebar-dm-view-all",
    },
    shellText("dm.viewAll"),
  );

  viewAllBtn.addEventListener("click", () => {
    setSidebarMode("dms");
  });

  // --- Render logic ---

  function renderDmListItems(): void {
    const dmChannels = dmStore.getState().channels;
    const displayChannels = dmChannels.slice(0, 3);
    reconcileChildren(dmList, displayChannels, {
      key: (dm) => String(dm.channelId),
      signature: dmRowSignature,
      create: (dm) => {
        const owner = new Disposable();
        const el = buildDmRow(dm, owner.signal, {
          onSelectDm: opts.onSelectDm,
          menu: opts.menu,
          confirmLeave,
        });
        rowOwners.set(el, owner);
        return el;
      },
      dispose: (el) => {
        rowOwners.get(el)?.destroy();
        rowOwners.delete(el);
      },
    });
    closeIfGone(dmChannels);
    // One Tab stop; arrows/Home/End step within the preview list.
    setRovingTabindex(dmList, "[data-testid='dm-entry']");

    // Show/hide "View All" button based on DM count (respect collapsed state)
    if (dmChannels.length > 3) {
      setText(viewAllBtn, shellText("dm.viewAllCount", { count: dmChannels.length }));
      viewAllBtn.style.display = dmCollapsed ? "none" : "";
    } else {
      viewAllBtn.style.display = "none";
    }

    // Update total unread badge on the DM header. A muted conversation is
    // not an interrupt, so it adds only its mentions; its own row still shows
    // its dimmed count.
    const totalUnread = totalDmUnread(dmChannels);
    if (totalUnread > 0) {
      // Each row's count is already capped at 100; cap the sum the same way so
      // the header reads "99+" instead of a four-digit total.
      setText(dmUnreadBadge, formatBadgeCount(totalUnread));
      dmUnreadBadge.style.display = "";
    } else {
      dmUnreadBadge.style.display = "none";
    }
  }

  renderDmListItems();
  dmSection.appendChild(dmList);
  dmSection.appendChild(viewAllBtn);

  // One Tab stop for the preview list; ArrowUp/Down step through the rows and
  // Enter/Space open one (nothing is hover-only). The listener lives on
  // the list, which survives every keyed re-render.
  enableRovingNavigation(dmList, "[data-testid='dm-entry']", listLifecycle.signal, "vertical");
  // A row's time is "3:04 PM" today and "Sep 29" after midnight.
  atEachMidnight(listLifecycle.signal, renderDmListItems);
  // A clock-format change relabels the preview times in place.
  onPrefChange(["timeFormat", "dateFormat"], () => renderDmListItems(), listLifecycle.signal);

  // A mute, a call starting or ending, and the DM list itself redraw the preview.
  watchDmListInputs(listLifecycle.signal, unsubs, renderDmListItems);

  // --- Collapse toggle ---
  function paintCollapsed(): void {
    dmHeader.classList.toggle("collapsed", dmCollapsed);
    dmArrow.textContent = dmCollapsed ? "\u25B6" : "\u25BC";
    dmArrow.setAttribute("aria-expanded", String(!dmCollapsed));
    dmList.style.display = dmCollapsed ? "none" : "";
    renderRequestsRow?.();
    viewAllBtn.style.display = dmCollapsed
      ? "none"
      : dmStore.getState().channels.length > 3
        ? ""
        : "none";
  }
  if (dmCollapsed) paintCollapsed();
  dmHeader.addEventListener("click", () => {
    // Saved per server with the categories, so it survives a remount or reload.
    toggleCategory(DM_SECTION_COLLAPSED_KEY);
    dmCollapsed = isCategoryCollapsed(DM_SECTION_COLLAPSED_KEY);
    paintCollapsed();
  });

  // --- Add DM button ---
  dmAddBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onNewDm();
  });

  return {
    element: dmSection,
    update: renderDmListItems,
    destroy: () => {
      listLifecycle.destroy();
      for (const owner of rowOwners.values()) owner.destroy();
      rowOwners.clear();
      for (const unsub of unsubs) {
        unsub();
      }
    },
  };
}
