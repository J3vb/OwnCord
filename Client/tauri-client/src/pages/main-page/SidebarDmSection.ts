/**
 * SidebarDmSection — the embedded DM preview section that sits above channels
 * in "channels" mode. Shows the top 3 DM conversations, an unread badge,
 * a "View all messages" button, and collapse toggle.
 */

import { createElement, setText, clearChildren, appendChildren } from "@lib/dom";
import { dmStore } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { setSidebarMode } from "@stores/ui.store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarDmSectionOptions {
  /** Called when the user clicks a DM entry to open that conversation. */
  readonly onSelectDm: (dmChannel: DmChannel) => void;
  /** Called when the user clicks the "+" button to create a new DM. */
  readonly onNewDm: () => void;
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

  // --- Root container ---
  const dmSection = createElement("div", { class: "sidebar-dm-section" });

  // --- Header ---
  const dmHeader = createElement("div", { class: "category" });
  const dmArrow = createElement("span", { class: "category-arrow" }, "\u25BC");
  const dmLabelEl = createElement("span", { class: "category-name" }, "DIRECT MESSAGES");
  const dmUnreadBadge = createElement("span", { class: "dm-header-unread-badge" });
  const dmAddBtn = createElement("button", { class: "category-add-btn", title: "New DM" }, "+");
  dmAddBtn.style.opacity = "1";
  appendChildren(dmHeader, dmArrow, dmLabelEl, dmUnreadBadge, dmAddBtn);
  dmSection.appendChild(dmHeader);

  // --- DM list ---
  let dmCollapsed = false;
  const dmList = createElement("div", { class: "category-channels sidebar-dm-list" });

  // --- "View All" button ---
  const viewAllBtn = createElement("button", {
    class: "sidebar-dm-view-all",
  }, "View all messages");

  viewAllBtn.addEventListener("click", () => {
    setSidebarMode("dms");
  });

  // --- Render logic ---
  function renderDmListItems(): void {
    clearChildren(dmList);
    const dmChannels = dmStore.getState().channels;
    const displayChannels = dmChannels.slice(0, 3);
    for (const dm of displayChannels) {
      const dmItem = createElement("div", {
        class: "channel-item",
        "data-testid": "dm-entry",
      });
      const statusColor = dm.recipient.status === "online" ? "var(--green)"
        : dm.recipient.status === "idle" ? "var(--yellow)"
        : dm.recipient.status === "dnd" ? "var(--red)"
        : "var(--text-micro)";
      const statusDot = createElement("span", {
        style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;`,
      });
      const name = createElement("span", { class: "ch-name" }, dm.recipient.username);
      const parts: Element[] = [statusDot, name];
      if (dm.unreadCount > 0) {
        const badge = createElement("span", {
          class: "dm-unread-badge",
          style: "margin-left:auto;background:var(--red);color:white;border-radius:10px;padding:1px 6px;font-size:0.7rem;",
        }, String(dm.unreadCount));
        parts.push(badge);
      }
      appendChildren(dmItem, ...parts);
      dmItem.addEventListener("click", () => {
        opts.onSelectDm(dm);
      });
      dmList.appendChild(dmItem);
    }

    // Show/hide "View All" button based on DM count (respect collapsed state)
    if (dmChannels.length > 3) {
      setText(viewAllBtn, `View all messages (${dmChannels.length})`);
      viewAllBtn.style.display = dmCollapsed ? "none" : "";
    } else {
      viewAllBtn.style.display = "none";
    }

    // Update total unread badge on the DM header
    const totalUnread = dmChannels.reduce((sum, c) => sum + c.unreadCount, 0);
    if (totalUnread > 0) {
      setText(dmUnreadBadge, String(totalUnread));
      dmUnreadBadge.style.display = "";
    } else {
      dmUnreadBadge.style.display = "none";
    }
  }

  renderDmListItems();
  dmSection.appendChild(dmList);
  dmSection.appendChild(viewAllBtn);

  // --- Store subscription ---
  const unsubDmSection = dmStore.subscribeSelector(
    (s) => s.channels,
    () => { renderDmListItems(); },
  );
  unsubs.push(unsubDmSection);

  // --- Collapse toggle ---
  dmHeader.addEventListener("click", () => {
    dmCollapsed = !dmCollapsed;
    dmHeader.classList.toggle("collapsed", dmCollapsed);
    dmArrow.textContent = dmCollapsed ? "\u25B6" : "\u25BC";
    dmList.style.display = dmCollapsed ? "none" : "";
    viewAllBtn.style.display = dmCollapsed ? "none" : (dmStore.getState().channels.length > 3 ? "" : "none");
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
      for (const unsub of unsubs) {
        unsub();
      }
    },
  };
}
