/**
 * One row of the embedded DM preview, and the pieces that decide when it is
 * redrawn (its signature) and what its context menu acts on.
 */
import { createElement, appendChildren } from "@lib/dom";
import { formatBadgeCount, formatDmRowTime } from "@lib/text/formatting";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { getChannelMute, isChannelMuted } from "@lib/prefs/channelMutes";
import { voiceText } from "../../i18n/voice";
import { dmPreviewText, isDmInCall } from "./SidebarDmHelpers";
import { rowActivity } from "../members/listeningLine";
import { createIcon } from "@lib/icons";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { applyStatusIndicator } from "@lib/ui/statusIndicator";
import { openDmContextMenu, type DmMenuActions, type DmMenuConvo } from "./dmContextMenu";

export interface BuildDmRowContext {
  readonly onSelectDm: (dm: DmChannel) => void;
  readonly menu: DmMenuActions | undefined;
  readonly confirmLeave: (convo: DmMenuConvo, onClose: (channelId: number) => void) => void;
}

/** Everything a preview row draws. A changed value rebuilds just that row. */
export function dmRowSignature(dm: DmChannel): string {
  return [
    dmDisplayName(dm),
    dm.isGroup ? "g" : "1",
    dm.recipient.status,
    dm.recipient.mobile === true && !dm.isGroup ? "p" : "",
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

export function buildDmRow(
  dm: DmChannel,
  signal: AbortSignal,
  ctx: BuildDmRowContext,
): HTMLDivElement {
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
  const statusDot = createElement("span", {
    class: dm.isGroup ? "dm-section-status dm-section-status-group" : "dm-section-status",
    "aria-hidden": "true",
  });
  if (dm.isGroup) statusDot.style.background = "var(--text-micro)";
  else applyStatusIndicator(statusDot, dm.recipient.status, dm.recipient.mobile === true);
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
  // addressed to the reader directly (see lib/prefs/channelMutes.ts).
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
    ctx.onSelectDm(dmStore.getState().channels.find((c) => c.channelId === dm.channelId) ?? dm);
  });
  const menuActions = ctx.menu;
  if (menuActions !== undefined) {
    const openMenu = (x: number, y: number): void => {
      // The row may have changed since it was built: read the live channel.
      const live = dmStore.getState().channels.find((c) => c.channelId === dm.channelId);
      if (live === undefined) return;
      openDmContextMenu({
        convo: menuConvo(live),
        actions: menuActions,
        confirmLeave: ctx.confirmLeave,
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
