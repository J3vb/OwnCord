/**
 * One conversation row of the DM list: avatar, name and preview, member count,
 * in-call glyph, close button and the unread or mention badge, plus the click,
 * context-menu and keyboard handlers.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { formatBadgeCount, formatDmRowTime } from "@lib/text/formatting";
import { createIcon } from "@lib/icons";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { getChannelMute } from "@lib/prefs/channelMutes";
import { requestsText } from "../../i18n/requests";
import { voiceText } from "../../i18n/voice";
import { buildAvatar } from "./dmAvatars";
import type { DmConversation, DmSidebarOptions } from "./dmConversation";
import { openDmContextMenu, type DmConfirmLeave, type DmMenuConvo } from "./dmContextMenu";

export function menuConvo(convo: DmConversation): DmMenuConvo {
  // Read the store as the menu opens: the list may have been drawn before a
  // timed mute ended (or was set elsewhere). An untimed `muted` flag from the
  // list still stands when the store has no entry.
  const live = getChannelMute(convo.channelId);
  const muted = live !== null || (convo.muted === true && convo.mutedUntil == null);
  return {
    channelId: convo.channelId,
    userId: convo.userId,
    username: convo.username,
    isGroup: convo.isGroup === true,
    hasOwner: convo.hasOwner === true,
    hasIcon: convo.icon !== undefined && convo.icon !== "",
    unread: convo.unread,
    muted,
    mutedUntil: live?.until ?? null,
  };
}

/** The name, optional activity line and last-message preview.
 *
 *  The preview and its time: Discord's DM list always shows the last line, and
 *  the data was already computed onto DmConversation. An empty timestamp means
 *  the DM was never messaged (lastMessage carries the "No messages yet"
 *  fallback), so there is no time to show. */
function buildBody(convo: DmConversation): HTMLDivElement {
  const name = createElement("span", { class: "dm-name" }, convo.username);
  const preview = createElement("span", { class: "dm-preview" }, convo.lastMessage);
  const body = createElement("div", { class: "dm-item-body" });
  if (convo.activity != null && convo.isGroup !== true) {
    const activity = createElement("span", {
      class: "dm-activity",
      "data-testid": `dm-activity-${convo.channelId}`,
    });
    const icon = createIcon(convo.activityIcon ?? "gamepad-2", 12);
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("dm-activity-icon");
    const text = createElement("span", { class: "dm-activity-text" });
    setText(text, convo.activity);
    appendChildren(activity, icon, text);
    appendChildren(body, name, activity, preview);
  } else {
    appendChildren(body, name, preview);
  }
  return body;
}

/** Participant count, groups only: the label may be a name that says nothing
 *  about size, and "who else is in here" is the first thing you want to know. */
function buildMemberCount(convo: DmConversation): HTMLElement {
  const count = (convo.participants ?? []).length + 1;
  const countEl = createElement(
    "span",
    { class: "dm-member-count", "data-testid": `dm-members-${convo.channelId}` },
    String(count),
  );
  countEl.title = requestsText("members.count", { count: String(count) });
  return countEl;
}

/** A live call is visible without opening the DM. The glyph has a name so
 *  it is not colour or shape alone. */
function buildCallGlyph(convo: DmConversation): HTMLElement {
  const glyph = createElement("span", {
    class: "dm-in-call",
    role: "img",
    "aria-label": voiceText("call.inProgress"),
    title: voiceText("call.inProgress"),
    "data-testid": `dm-in-call-${convo.channelId}`,
  });
  glyph.appendChild(createIcon("phone", 14));
  return glyph;
}

/** Close / leave button (hidden by default, shown on hover via CSS). */
function buildCloseButton(
  convo: DmConversation,
  options: DmSidebarOptions,
  signal: AbortSignal,
  confirmLeave: DmConfirmLeave,
): HTMLElement {
  const closeBtn = createElement("button", {
    class: "dm-close",
    title: convo.isGroup === true ? requestsText("dm.leaveShort") : requestsText("dm.closeShort"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  closeBtn.addEventListener(
    "click",
    (e: Event) => {
      e.stopPropagation();
      const close = options.onCloseDm;
      if (close === undefined) return;
      // A group leave is destructive and asks first. Shift-click skips
      // the prompt, as Discord's delete confirm does. A 1:1 close is only a
      // hide, so it stays one click.
      if (convo.isGroup === true && !(e instanceof MouseEvent && e.shiftKey)) {
        confirmLeave(menuConvo(convo), close);
        return;
      }
      close(convo.channelId);
    },
    { signal },
  );
  return closeBtn;
}

/** A mention badge outranks the unread badge, which in turn outranks the bare
 *  dot — the dot is only what is left when the payload carries no counts.
 *
 *  A muted conversation dims the unread badge but NOT the mention badge: the
 *  whole point of Discord's mute is that things addressed to you still get
 *  through, so dimming both would make a mute unsafe to use. */
function buildUnreadMarker(convo: DmConversation): HTMLElement | null {
  const mentionCount = convo.mentionCount ?? 0;
  const unreadCount = convo.unreadCount ?? 0;
  if (mentionCount > 0) {
    const badge = createElement(
      "span",
      { class: "dm-mention-badge", "data-testid": `dm-mentions-${convo.channelId}` },
      String(mentionCount),
    );
    badge.title = requestsText("mention.count", { count: mentionCount, n: String(mentionCount) });
    return badge;
  }
  if (unreadCount > 0) {
    const badge = createElement(
      "span",
      {
        class: convo.muted === true ? "dm-unread-badge muted" : "dm-unread-badge",
        "data-testid": `dm-unread-${convo.channelId}`,
      },
      formatBadgeCount(unreadCount),
    );
    badge.title = requestsText("unread.count", {
      count: unreadCount,
      n: formatBadgeCount(unreadCount),
    });
    return badge;
  }
  if (convo.unread) return createElement("span", { class: "dm-unread" });
  return null;
}

function attachRowHandlers(
  item: HTMLElement,
  convo: DmConversation,
  options: DmSidebarOptions,
  signal: AbortSignal,
  confirmLeave: DmConfirmLeave,
): void {
  item.addEventListener(
    "click",
    () => {
      const parent = item.parentElement;
      if (parent !== null) {
        for (const sibling of parent.querySelectorAll(".dm-item.active")) {
          sibling.classList.remove("active");
        }
      }
      item.classList.add("active");
      options.onSelectConversation(convo.channelId);
    },
    { signal },
  );

  const openDmMenu = (x: number, y: number): void => {
    openDmContextMenu({
      convo: menuConvo(convo),
      actions: options,
      confirmLeave,
      x,
      y,
      signal,
    });
  };
  item.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
      openDmMenu(e.clientX, e.clientY);
    },
    { signal },
  );
  // Keyboard entry point (A11Y-01): Shift+F10 / Menu key on the focused row.
  openMenuOnKeyboard(item, openDmMenu, signal);
}

export function renderDmItem(
  convo: DmConversation,
  options: DmSidebarOptions,
  signal: AbortSignal,
  confirmLeave: DmConfirmLeave,
): HTMLDivElement {
  const item = createElement("div", {
    class: "dm-item",
    // Roving list item: reachable by Tab once, then arrow-stepped.
    role: "button",
    tabindex: "-1",
  });
  if (convo.active === true) {
    item.classList.add("active");
  }
  if (convo.muted === true) {
    item.classList.add("muted");
  }
  item.dataset.channelId = String(convo.channelId);
  item.dataset.userId = String(convo.userId);

  const avatar = buildAvatar(convo);
  const body = buildBody(convo);
  const time = createElement(
    "span",
    { class: "dm-preview-time" },
    formatDmRowTime(convo.timestamp),
  );
  appendChildren(item, avatar, body, time);

  if (convo.isGroup === true) item.appendChild(buildMemberCount(convo));
  if (convo.inCall === true) item.appendChild(buildCallGlyph(convo));
  item.appendChild(buildCloseButton(convo, options, signal, confirmLeave));
  const marker = buildUnreadMarker(convo);
  if (marker !== null) item.appendChild(marker);

  attachRowHandlers(item, convo, options, signal, confirmLeave);
  return item;
}

/** What identifies the row's picture and label. */
function appearanceParts(convo: DmConversation): (string | number)[] {
  const isGroup = convo.isGroup === true;
  return [
    convo.username,
    convo.avatar ?? "",
    convo.avatarColor ?? "",
    convo.status ?? "",
    convo.mobile === true && !isGroup ? "p" : "",
    isGroup ? "" : `${convo.activityIcon ?? ""}|${convo.activity ?? ""}`,
    isGroup ? "g" : "",
    convo.icon ?? "",
    (convo.participants ?? []).length,
  ];
}

/** What marks the row's state and last message. */
function stateParts(convo: DmConversation): (string | number)[] {
  return [
    convo.active === true ? "a" : "",
    convo.muted === true ? "m" : "",
    convo.unread === true ? "u" : "",
    convo.unreadCount ?? 0,
    convo.mentionCount ?? 0,
    convo.inCall === true ? "c" : "",
    convo.lastMessage,
    formatDmRowTime(convo.timestamp),
  ];
}

/** Everything a row draws. A changed value rebuilds just that row. */
export function convoSignature(convo: DmConversation): string {
  return [...appearanceParts(convo), ...stateParts(convo)].join("|");
}
