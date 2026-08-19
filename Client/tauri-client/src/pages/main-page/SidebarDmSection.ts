/**
 * SidebarDmSection — the embedded DM preview section that sits above channels
 * in "channels" mode. Shows the top 3 DM conversations, an unread badge,
 * a "View all messages" button, and collapse toggle.
 */

import { createElement, setText, clearChildren, appendChildren } from "@lib/dom";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { setSidebarMode } from "@stores/ui.store";
import { isChannelMuted } from "@lib/channel-mutes";

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
  const viewAllBtn = createElement(
    "button",
    {
      class: "sidebar-dm-view-all",
    },
    "View all messages",
  );

  viewAllBtn.addEventListener("click", () => {
    setSidebarMode("dms");
  });

  // --- Render logic ---
  function renderDmListItems(): void {
    clearChildren(dmList);
    const dmChannels = dmStore.getState().channels;
    const displayChannels = dmChannels.slice(0, 3);
    for (const dm of displayChannels) {
      const muted = isChannelMuted(dm.channelId);
      const dmItem = createElement("div", {
        class: muted ? "channel-item muted" : "channel-item",
        "data-testid": "dm-entry",
      });
      // A group has no presence of its own, so it gets a neutral marker rather
      // than the first member's dot dressed up as the conversation's state.
      const statusColor = dm.isGroup
        ? "var(--text-micro)"
        : dm.recipient.status === "online"
          ? "var(--green)"
          : dm.recipient.status === "idle"
            ? "var(--yellow)"
            : dm.recipient.status === "dnd"
              ? "var(--red)"
              : "var(--text-micro)";
      const statusDot = createElement("span", {
        style: `display:inline-block;width:8px;height:8px;border-radius:${dm.isGroup ? "2px" : "50%"};background:${statusColor};flex-shrink:0;`,
      });
      const name = createElement("span", { class: "ch-name" }, dmDisplayName(dm));
      const parts: Element[] = [statusDot, name];
      // A mention badge outranks the plain unread badge, and a mute never
      // dims or suppresses it: a mute silences chatter, never something
      // addressed to the reader directly (see lib/channel-mutes.ts).
      if (dm.mentionCount > 0) {
        const mentionBadge = createElement(
          "span",
          {
            class: "dm-mention-badge",
            style: `margin-left:auto;background:var(--red);color:white;border-radius:10px;padding:1px 6px;font-size:0.7rem;`,
          },
          String(dm.mentionCount),
        );
        parts.push(mentionBadge);
      } else if (dm.unreadCount > 0) {
        // Muted: the count still increments (it is a fact about the channel),
        // it just stops shouting. Only the colour changes.
        const badge = createElement(
          "span",
          {
            class: muted ? "dm-unread-badge muted" : "dm-unread-badge",
            style: `margin-left:auto;background:${muted ? "var(--text-micro)" : "var(--red)"};color:white;border-radius:10px;padding:1px 6px;font-size:0.7rem;`,
          },
          String(dm.unreadCount),
        );
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

    // Update total unread badge on the DM header. Muted conversations are
    // excluded: the header badge is an interrupt, and a muted DM asked not to
    // be one. Its own row still shows its dimmed count. A mention is the one
    // thing a mute must never swallow, so a muted channel still contributes
    // its mentionCount (never its raw unreadCount) to the total.
    const totalUnread = dmChannels.reduce(
      (sum, c) => sum + (isChannelMuted(c.channelId) ? c.mentionCount : c.unreadCount),
      0,
    );
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
    () => {
      renderDmListItems();
    },
  );
  unsubs.push(unsubDmSection);

  // --- Collapse toggle ---
  dmHeader.addEventListener("click", () => {
    dmCollapsed = !dmCollapsed;
    dmHeader.classList.toggle("collapsed", dmCollapsed);
    dmArrow.textContent = dmCollapsed ? "\u25B6" : "\u25BC";
    dmList.style.display = dmCollapsed ? "none" : "";
    viewAllBtn.style.display = dmCollapsed
      ? "none"
      : dmStore.getState().channels.length > 3
        ? ""
        : "none";
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
