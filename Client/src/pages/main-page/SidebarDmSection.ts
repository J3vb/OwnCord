/**
 * SidebarDmSection — the embedded DM preview section that sits above channels
 * in "channels" mode. Shows the top 3 DM conversations, an unread badge,
 * a "View all messages" button, and collapse toggle.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { atEachMidnight, formatBadgeCount, formatDmRowTime } from "@lib/formatting";
import { reconcileChildren } from "@lib/reconcile";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { totalDmUnread } from "@lib/dmUnread";
import type { DmChannel } from "@stores/dm.store";
import { setSidebarMode } from "@stores/ui.store";
import { CHANNEL_MUTE_CHANGED, getChannelMute, isChannelMuted } from "@lib/channel-mutes";
import { trackCurrentView } from "../../features/navigation/contentView";
import type { CountSource } from "../../features/navigation/destinations";
import { navigationText } from "../../i18n/navigation";
import { shellText } from "../../i18n/shell";
import { voiceStore } from "@stores/voice.store";
import { createIcon } from "@lib/icons";
import { openMenuOnKeyboard } from "@lib/context-menu";
import type { ModalInstance } from "@lib/modalFactory";
import {
  openDmContextMenu,
  openLeaveConfirm,
  type DmMenuActions,
  type DmMenuConvo,
} from "@components/dmContextMenu";
import { voiceText } from "../../i18n/voice";
import { dmPreviewText, isDmInCall } from "./SidebarDmHelpers";
import { rowActivity } from "../../features/members/listeningLine";
import { onPrefChange } from "@lib/preferences";

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

/** Everything a preview row draws. A changed value rebuilds just that row. */
function dmRowSignature(dm: DmChannel): string {
  return [
    dmDisplayName(dm),
    dm.isGroup ? "g" : "1",
    dm.recipient.status,
    dm.isGroup ? "" : (rowActivity(dm.recipient.activity, dm.recipient.listening)?.text ?? ""),
    isChannelMuted(dm.channelId) ? "m" : "",
    isDmInCall(dm.channelId) ? "c" : "",
    dm.mentionCount,
    dm.unreadCount,
    dmPreviewText(dm),
    formatDmRowTime(dm.lastMessageAt),
  ].join("|");
}

function menuConvo(dm: DmChannel): DmMenuConvo {
  return {
    channelId: dm.channelId,
    userId: dm.recipient.id,
    username: dmDisplayName(dm),
    isGroup: dm.isGroup,
    hasOwner: dm.ownerId !== undefined,
    hasIcon: dm.icon !== undefined && dm.icon !== "",
    unread: dm.unreadCount > 0 || dm.mentionCount > 0,
    muted: isChannelMuted(dm.channelId),
    mutedUntil: getChannelMute(dm.channelId)?.until ?? null,
  };
}

export function createSidebarDmSection(opts: SidebarDmSectionOptions): SidebarDmSectionResult {
  const unsubs: Array<() => void> = [];
  const listLifecycle = new Disposable();
  // Each row's menu listeners die with the row, not with the section.
  const rowOwners = new Map<Element, Disposable>();
  let leavePrompt: { channelId: number; modal: ModalInstance } | null = null;

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
  let dmCollapsed = false;

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

  function confirmLeave(convo: DmMenuConvo, onClose: (channelId: number) => void): void {
    leavePrompt = {
      channelId: convo.channelId,
      modal: openLeaveConfirm(convo, onClose, listLifecycle.signal),
    };
  }

  function buildDmRow(dm: DmChannel, signal: AbortSignal): HTMLDivElement {
    const muted = isChannelMuted(dm.channelId);
    const dmItem = createElement("div", {
      class: muted ? "channel-item muted" : "channel-item",
      "data-testid": "dm-entry",
      // Roving list item: reachable by Tab once, then arrow-stepped.
      role: "button",
      tabindex: "-1",
    });
    dmItem.dataset.channelId = String(dm.channelId);
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
      "aria-hidden": "true",
    });
    const name = createElement("span", { class: "ch-name" }, dmDisplayName(dm));
    // Discord's DM list shows the last line and when it arrived. An empty
    // timestamp means the DM was never messaged, so no time is drawn.
    const preview = createElement("span", { class: "dm-preview" }, dmPreviewText(dm));
    const body = createElement("div", { class: "dm-item-body" });
    // A 1:1 partner's game, else their music, between the name and the last
    // line.
    const shown = dm.isGroup ? null : rowActivity(dm.recipient.activity, dm.recipient.listening);
    if (shown !== null) {
      const activity = createElement("span", {
        class: "dm-activity",
        "data-testid": `dm-activity-${dm.channelId}`,
      });
      const icon = createIcon(shown.icon, 12);
      icon.setAttribute("aria-hidden", "true");
      icon.classList.add("dm-activity-icon");
      const text = createElement("span", { class: "dm-activity-text" });
      text.textContent = shown.text;
      appendChildren(activity, icon, text);
      appendChildren(body, name, activity, preview);
    } else {
      appendChildren(body, name, preview);
    }
    const time = createElement(
      "span",
      { class: "dm-preview-time" },
      formatDmRowTime(dm.lastMessageAt),
    );
    const parts: Element[] = [statusDot, body, time];
    // A live call is visible without opening the DM, as in the full list.
    if (isDmInCall(dm.channelId)) {
      const glyph = createElement("span", {
        class: "dm-in-call",
        role: "img",
        "aria-label": voiceText("call.inProgress"),
        title: voiceText("call.inProgress"),
        "data-testid": `dm-in-call-${dm.channelId}`,
      });
      glyph.appendChild(createIcon("phone", 14));
      parts.push(glyph);
    }
    // A mention badge outranks the plain unread badge, and a mute never
    // dims or suppresses it: a mute silences chatter, never something
    // addressed to the reader directly (see lib/channel-mutes.ts).
    if (dm.mentionCount > 0) {
      const mentionBadge = createElement(
        "span",
        {
          class: "dm-mention-badge",
          style: `margin-left:auto;background:var(--danger-fill);color:var(--on-fill);border-radius:10px;padding:1px 6px;font-size:0.7rem;`,
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
          style: `margin-left:auto;background:${muted ? "var(--text-micro)" : "var(--danger-fill)"};color:var(--on-fill);border-radius:10px;padding:1px 6px;font-size:0.7rem;`,
        },
        formatBadgeCount(dm.unreadCount),
      );
      parts.push(badge);
    }
    appendChildren(dmItem, ...parts);
    dmItem.addEventListener("click", () => {
      opts.onSelectDm(dmStore.getState().channels.find((c) => c.channelId === dm.channelId) ?? dm);
    });
    const menuActions = opts.menu;
    if (menuActions !== undefined) {
      const openMenu = (x: number, y: number): void => {
        // The row may have changed since it was built: read the live channel.
        const live = dmStore.getState().channels.find((c) => c.channelId === dm.channelId);
        if (live === undefined) return;
        openDmContextMenu({
          convo: menuConvo(live),
          actions: menuActions,
          confirmLeave,
          x,
          y,
          signal,
        });
      };
      dmItem.addEventListener(
        "contextmenu",
        (e: MouseEvent) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        },
        { signal },
      );
      openMenuOnKeyboard(dmItem, openMenu, signal);
    }
    return dmItem;
  }

  function renderDmListItems(): void {
    const dmChannels = dmStore.getState().channels;
    const displayChannels = dmChannels.slice(0, 3);
    reconcileChildren(dmList, displayChannels, {
      key: (dm) => String(dm.channelId),
      signature: dmRowSignature,
      create: (dm) => {
        const owner = new Disposable();
        const el = buildDmRow(dm, owner.signal);
        rowOwners.set(el, owner);
        return el;
      },
      dispose: (el) => {
        rowOwners.get(el)?.destroy();
        rowOwners.delete(el);
      },
    });
    if (leavePrompt !== null && !dmChannels.some((c) => c.channelId === leavePrompt?.channelId)) {
      leavePrompt.modal.close();
      leavePrompt = null;
    }
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
  onPrefChange(["timeFormat"], () => renderDmListItems(), listLifecycle.signal);

  // A mute toggled from a row menu (or Settings) is not in a store.
  window.addEventListener(CHANNEL_MUTE_CHANGED, () => renderDmListItems(), {
    signal: listLifecycle.signal,
  });
  // The live-call glyph follows who is in each DM's voice channel. Occupied
  // channels only: a speaking tick replaces voiceUsers too and must not redraw.
  unsubs.push(
    voiceStore.subscribeSelector(
      (s) =>
        [...s.voiceUsers]
          .filter(([, users]) => users.size > 0)
          .map(([id]) => id)
          .join(","),
      () => renderDmListItems(),
    ),
  );

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
    dmArrow.setAttribute("aria-expanded", String(!dmCollapsed));
    dmList.style.display = dmCollapsed ? "none" : "";
    renderRequestsRow?.();
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
      listLifecycle.destroy();
      for (const owner of rowOwners.values()) owner.destroy();
      rowOwners.clear();
      for (const unsub of unsubs) {
        unsub();
      }
    },
  };
}
