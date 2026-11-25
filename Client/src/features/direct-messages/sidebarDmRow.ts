/**
 * One row of the embedded DM preview, and the pieces that decide when it is
 * redrawn (its signature) and what its context menu acts on.
 */
import { createElement, appendChildren } from "@lib/dom";
import { formatBadgeCount, formatDmRowTime } from "../messaging/formatting";
import type { RowModel } from "@lib/net/reconcile";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { CHANNEL_MUTE_CHANGED, getChannelMute, isChannelMuted } from "@lib/prefs/channelMutes";
import { voiceText } from "../../i18n/voice";
import { dmConversationOf, dmPreviewText, isDmInCall } from "./SidebarDmHelpers";
import type { DmConversation } from "./dmConversation";
import { buildAvatar } from "./dmAvatars";
import { buildMemberCount } from "./dmRow";
import { rowActivity } from "../members/listeningLine";
import { createIcon } from "@lib/icons";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { applyStatusIndicator } from "@lib/ui/statusIndicator";
import type { ModalInstance } from "@lib/ui/modalFactory";
import {
  openDmContextMenu,
  openLeaveConfirm,
  type DmMenuActions,
  type DmMenuConvo,
} from "./dmContextMenu";

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

/** The live-call glyph, shown without opening the DM. */
function buildInCallGlyph(channelId: number): HTMLElement {
  const glyph = createElement("span", {
    class: "dm-in-call",
    role: "img",
    "aria-label": voiceText("call.inProgress"),
    title: voiceText("call.inProgress"),
    "data-testid": `dm-in-call-${channelId}`,
  });
  glyph.appendChild(createIcon("phone", 14));
  return glyph;
}

/** A mention badge outranks the plain unread badge, and a mute never dims or
 *  suppresses it: a mute silences chatter, never something addressed to the
 *  reader directly (see lib/prefs/channelMutes.ts). A muted unread count still
 *  increments; it just stops shouting. */
function buildCountBadge(counts: {
  readonly mentionCount: number;
  readonly unreadCount: number;
  readonly muted: boolean;
}): HTMLElement | null {
  if (counts.mentionCount > 0) {
    return createElement(
      "span",
      {
        class: "dm-mention-badge",
        style: `margin-left:auto;background:var(--danger-fill);color:var(--on-fill);border-radius:10px;padding:1px 6px;font-size:0.7rem;`,
      },
      String(counts.mentionCount),
    );
  }
  if (counts.unreadCount === 0) return null;
  return createElement(
    "span",
    {
      class: counts.muted ? "dm-unread-badge muted" : "dm-unread-badge",
      style: `margin-left:auto;background:${counts.muted ? "var(--text-micro)" : "var(--danger-fill)"};color:var(--on-fill);border-radius:10px;padding:1px 6px;font-size:0.7rem;`,
    },
    formatBadgeCount(counts.unreadCount),
  );
}

/**
 * The row's click and menu. Both read the live DM by channel at event time:
 * the row may have changed since it was built, and `fallback` (the DM the row
 * was drawn from, when there is one) only covers a click on a row whose DM has
 * just left the store.
 */
function wireDmRow(
  row: HTMLElement,
  channelId: number,
  fallback: DmChannel | null,
  signal: AbortSignal,
  ctx: BuildDmRowContext,
): void {
  const live = (): DmChannel | undefined =>
    dmStore.getState().channels.find((c) => c.channelId === channelId);
  row.addEventListener("click", () => {
    const dm = live() ?? fallback;
    if (dm !== null) ctx.onSelectDm(dm);
  });
  const menuActions = ctx.menu;
  if (menuActions === undefined) return;
  const openMenu = (x: number, y: number): void => {
    const current = live();
    if (current === undefined) return;
    openDmContextMenu({
      convo: menuConvo(current),
      actions: menuActions,
      confirmLeave: ctx.confirmLeave,
      x,
      y,
      signal,
    });
  };
  row.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    },
    { signal },
  );
  openMenuOnKeyboard(row, openMenu, signal);
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
  if (isDmInCall(dm.channelId)) parts.push(buildInCallGlyph(dm.channelId));
  const badge = buildCountBadge({ ...dm, muted });
  if (badge !== null) parts.push(badge);
  appendChildren(dmItem, ...parts);
  wireDmRow(dmItem, dm.channelId, dm, signal, ctx);
  return dmItem;
}

// ---------------------------------------------------------------------------
// The Direct folder's rows
// ---------------------------------------------------------------------------

/**
 * Everything a Direct folder row draws, as plain values (`null` for absent), so
 * the reconciler compares rows structurally. It has no patch fields: any
 * change rebuilds that row.
 */
export interface DmFolderRowModel extends RowModel {
  readonly channelId: number;
  readonly name: string;
  readonly isGroup: boolean;
  readonly status: string;
  readonly mobile: boolean;
  readonly avatar: string | null;
  readonly avatarColor: string | null;
  readonly icon: string | null;
  readonly participants: readonly {
    readonly id: number;
    readonly username: string;
    readonly avatar: string | null;
  }[];
  readonly memberCount: number;
  readonly muted: boolean;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly inCall: boolean;
  readonly active: boolean;
  /** The last message's words; only the row's tooltip. */
  readonly preview: string;
}

export function dmFolderRowModel(dm: DmChannel, activeChannelId: number | null): DmFolderRowModel {
  const convo = dmConversationOf(dm, activeChannelId);
  return {
    channelId: dm.channelId,
    name: convo.username,
    isGroup: dm.isGroup,
    status: convo.status ?? "offline",
    mobile: convo.mobile === true,
    avatar: convo.avatar,
    avatarColor: convo.avatarColor ?? null,
    icon: convo.icon ?? null,
    participants: (convo.participants ?? []).map((p) => ({ ...p })),
    memberCount: dm.participants.length + 1,
    muted: convo.muted === true,
    unreadCount: dm.unreadCount,
    mentionCount: dm.mentionCount,
    inCall: isDmInCall(dm.channelId),
    active: convo.active === true,
    preview: convo.lastMessage,
  };
}

/** The shape `buildAvatar` and the member count read, from a folder row's model. */
function convoOfModel(model: DmFolderRowModel): DmConversation {
  return {
    channelId: model.channelId,
    // The avatar and the member count read the channel, name and participants only.
    userId: 0,
    username: model.name,
    avatar: model.avatar,
    ...(model.avatarColor !== null && { avatarColor: model.avatarColor }),
    status: model.status as DmConversation["status"],
    ...(model.mobile && { mobile: true }),
    isGroup: model.isGroup,
    ...(model.icon !== null && { icon: model.icon }),
    participants: model.participants,
    lastMessage: model.preview,
    timestamp: "",
    unread: false,
  };
}

/** The classes a folder row carries: `unread` is the gutter dot, so a muted row has none. */
function folderRowClass(model: DmFolderRowModel): string {
  return [
    "channel-item",
    model.muted && "muted",
    model.unreadCount > 0 && !model.muted && "unread",
    model.active && "active",
  ]
    .filter((c) => c !== false)
    .join(" ");
}

/**
 * One row of the Direct folder, drawn from its model: a tree item with the
 * avatar (which carries the one presence dot), the name, a group's member
 * count, the call glyph and the count badge. The time and the activity line
 * are not drawn, and the preview is only the tooltip.
 */
export function buildDmFolderRow(
  model: DmFolderRowModel,
  signal: AbortSignal,
  ctx: BuildDmRowContext,
): HTMLElement {
  const row = createElement("div", {
    class: folderRowClass(model),
    "data-testid": "dm-entry",
    role: "treeitem",
    "data-tree-kind": "row",
    tabindex: "-1",
    title: model.preview,
  });
  row.dataset.channelId = String(model.channelId);
  if (model.active) row.setAttribute("aria-current", "page");
  const convo = convoOfModel(model);
  row.appendChild(buildAvatar(convo));
  row.appendChild(createElement("span", { class: "ch-name" }, model.name));
  if (model.isGroup) row.appendChild(buildMemberCount(convo));
  if (model.inCall) row.appendChild(buildInCallGlyph(model.channelId));
  const badge = buildCountBadge(model);
  if (badge !== null) row.appendChild(badge);
  wireDmRow(row, model.channelId, null, signal, ctx);
  return row;
}

// ---------------------------------------------------------------------------
// Shared by the preview section and the folder
// ---------------------------------------------------------------------------

/**
 * The leave prompt a DM list opens from a row's menu. `closeIfGone` closes it
 * once its DM is no longer in the list, so a DM another device left cannot
 * leave a prompt for a conversation that is gone.
 */
export function createLeavePrompt(signal: AbortSignal): {
  readonly confirmLeave: BuildDmRowContext["confirmLeave"];
  readonly closeIfGone: (channels: readonly DmChannel[]) => void;
} {
  let prompt: { readonly channelId: number; readonly modal: ModalInstance } | null = null;
  return {
    confirmLeave: (convo, onClose) => {
      prompt = { channelId: convo.channelId, modal: openLeaveConfirm(convo, onClose, signal) };
    },
    closeIfGone: (channels) => {
      const open = prompt;
      if (open === null || channels.some((c) => c.channelId === open.channelId)) return;
      open.modal.close();
      prompt = null;
    },
  };
}

/**
 * Redraw a DM list when what it shows changes outside its own events: a mute
 * toggled anywhere (not in a store), a DM's call starting or ending, and the DM
 * list itself. The window listener dies with `signal`; the store listeners go
 * on `unsubs`.
 */
export function watchDmListInputs(
  signal: AbortSignal,
  unsubs: Array<() => void>,
  redraw: () => void,
): void {
  window.addEventListener(CHANNEL_MUTE_CHANGED, () => redraw(), { signal });
  // Occupied channels only: a speaking tick replaces voiceUsers too and must not redraw.
  unsubs.push(
    voiceStore.subscribeSelector(
      (s) =>
        [...s.voiceUsers]
          .filter(([, users]) => users.size > 0)
          .map(([id]) => id)
          .join(","),
      () => redraw(),
    ),
  );
  unsubs.push(
    dmStore.subscribeSelector(
      (s) => s.channels,
      () => redraw(),
    ),
  );
}
