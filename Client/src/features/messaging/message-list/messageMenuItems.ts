/**
 * The rows of the message right-click menu and phone sheet: which actions a
 * message offers, in order, each behind a guarded click that re-reads the
 * message first. messageMenu.ts opens them.
 */

import type { ContextMenuItem, ContextMenuSeparator } from "@lib/ui/contextMenu";
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import type { Message } from "@stores/messages.store";
import { isServerRowKind } from "@lib/text/messageKind";

import { emojiNode, quickReactionEmoji } from "./quickReactions";
import type { MessageListOptions } from "../MessageList";
import { connectText } from "../../../i18n/connect";
import { imageMenuText } from "../../../i18n/imageMenu";
import { messageMenuText } from "../../../i18n/messageMenu";
import { copyWithToast } from "../../developer-mode/developerTools";
import { messagingText } from "../../../i18n/messaging";
import {
  deleteLockReason,
  findMessage,
  copyMessageLink,
  messageActionGates,
  type MessageActionGates,
} from "./messageActions";
import { atReactionLimit } from "./reactions";
import { copyThenToast } from "@lib/ui/clipboard";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { desktop } from "../../../platform/desktop";

const log = createLogger("message-menu");

export interface MessageMenuRequest {
  readonly msg: Message;
  readonly opts: MessageListOptions;
  /** Pointer position; (0, 0) is a keyboard open (Menu key, Shift+F10). */
  readonly x: number;
  readonly y: number;
  /** What was right-clicked; a link inside the content adds the link rows. */
  readonly target: Element | null;
  /** The owning list's signal: a channel switch or teardown closes the menu. */
  readonly signal: AbortSignal;
  /** A control that opened the menu (3A-7's "..." button): marked expanded
   *  while open, and given focus back on close. */
  readonly invoker?: HTMLElement;
  /** Marks a message unread from here (the list's own handler: it also moves the
   *  NEW line). Absent, or without a server read pointer, the item is not offered. */
  readonly markUnread?: (messageId: number) => void;
}

export function rowOf(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="message-${id}"]`);
}

function copyText(text: string): void {
  copyThenToast(text, messageMenuText("copied"), messageMenuText("copyFailed"));
}

function shareText(text: string): void {
  desktop.shareSheet.shareText(text).catch((err: unknown) => {
    log.warn("Share message failed", { error: String(err) });
    showToast(messageMenuText("shareFailed"), "error");
  });
}

/** The selected text, when the selection starts and ends inside `row`. */
function selectionIn(row: HTMLElement | null): string {
  const selection = window.getSelection();
  if (row === null || selection === null || selection.isCollapsed) return "";
  const { anchorNode, focusNode } = selection;
  if (anchorNode === null || focusNode === null) return "";
  if (!row.contains(anchorNode) || !row.contains(focusNode)) return "";
  return selection.toString();
}

const LINK_SELECTOR = '.msg-text a[href^="http"]';

/** The row's one web link; null when it has none or several. */
function onlyLinkIn(row: HTMLElement | null): HTMLAnchorElement | null {
  const links = row?.querySelectorAll<HTMLAnchorElement>(LINK_SELECTOR) ?? [];
  const hrefs = new Set([...links].map((a) => a.getAttribute("href")));
  return hrefs.size === 1 ? (links[0] ?? null) : null;
}

type MenuEntry = ContextMenuItem | ContextMenuSeparator;
type Actor = (fn: (current: Message, e: MouseEvent) => void) => (e: MouseEvent) => void;

/** What every group of rows reads: the request, its gates and the guarded click. */
interface MenuContext {
  readonly msg: Message;
  readonly opts: MessageListOptions;
  readonly gates: MessageActionGates;
  readonly act: Actor;
}

const SEPARATOR: ContextMenuSeparator = { separator: true };

/** `disabled` plus the reason as a tooltip, for a row that can be locked. */
function lockProps(reason: string | null): { disabled: boolean; title?: string } {
  return { disabled: reason !== null, ...(reason !== null ? { title: reason } : {}) };
}

const copyIdItem = (msg: Message, act: Actor | null): ContextMenuItem => {
  const copy = (): void => copyWithToast(String(msg.id), "toast.idCopied", "toast.idCopyFailed");
  return {
    label: messageMenuText("copyId"),
    testId: "msg-menu-copy-id",
    icon: "copy",
    onClick: act === null ? copy : act(copy),
  };
};

/** A server row (call log, group event) offers nothing but Copy ID (developer
 *  mode); a pin row also offers Delete when the viewer may delete it. */
function serverRowItems(msg: Message, opts: MessageListOptions, gates: MessageActionGates) {
  const items: MenuEntry[] = [];
  if (gates.copyId.shown) items.push(copyIdItem(msg, null));
  if (gates.delete.shown) {
    if (items.length > 0) items.push(SEPARATOR);
    items.push({
      label: messageMenuText("delete"),
      testId: "msg-menu-delete",
      icon: "trash-2",
      danger: true,
      ...lockProps(gates.delete.reason),
      onClick: (e: MouseEvent) => {
        const found = findMessage(msg.channelId, msg.id);
        if (found === undefined || found.deleted) return;
        // The socket may have dropped since the menu opened.
        if (deleteLockReason() !== null) return;
        opts.onDeleteClick(found.id, e.shiftKey);
      },
    });
  }
  return { items, group: null };
}

/** Copy Link / Open Link for a link under the pointer. A finger rarely lands on
 *  the link itself: on a phone, a message with one link offers it wherever the
 *  row was pressed. */
function linkItems(
  ctx: MenuContext,
  req: MessageMenuRequest,
  row: HTMLElement | null,
  phone: boolean,
): MenuEntry[] {
  const anchor =
    req.target?.closest<HTMLAnchorElement>(LINK_SELECTOR) ?? (phone ? onlyLinkIn(row) : null);
  const href = anchor?.getAttribute("href") ?? null;
  if (anchor === null || href === null) return [];
  const { act, msg } = ctx;
  return [
    {
      label: imageMenuText("copyLink"),
      testId: "msg-menu-copy-link",
      icon: "link",
      onClick: act(() => {
        copyThenToast(href, imageMenuText("linkCopied"), imageMenuText("linkCopyFailed"));
      }),
    },
    {
      label: imageMenuText("openLink"),
      testId: "msg-menu-open-link",
      icon: "external-link",
      // Clicking the anchor itself, so the masked-link warning and the
      // external-link handler decide, as for a plain click. The row is looked
      // up now, not at open: virtual scrolling may have replaced it, and its
      // fresh copy of the same link is the one that is on the page.
      onClick: act(() => {
        const el = anchor.isConnected
          ? anchor
          : [...(rowOf(msg.id)?.querySelectorAll<HTMLAnchorElement>(".msg-text a") ?? [])].find(
              (a) => a.getAttribute("href") === href,
            );
        el?.click();
      }),
    },
    SEPARATOR,
  ];
}

/** The quick-reaction group, then Add Reaction, then a separator. */
function reactionItems(
  ctx: MenuContext,
  quickCount: number,
  start: number,
): { items: MenuEntry[]; group: { start: number; count: number } | null } {
  const { act, msg, opts, gates } = ctx;
  const items: MenuEntry[] = [];
  const reactLock = gates.react.reason;
  let count = 0;
  for (const emoji of quickReactionEmoji(quickCount)) {
    if (atReactionLimit(msg.reactions, emoji)) continue;
    const { node, name } = emojiNode(emoji);
    items.push({
      label: messagingText("action.reactWith", { name }),
      content: node,
      testId: `msg-menu-quick-${emoji}`,
      ...lockProps(reactLock),
      onClick: act((m) => opts.onReactionClick(m.id, emoji)),
    });
    count++;
  }
  const full = atReactionLimit(msg.reactions, null);
  const addLock = reactLock ?? (full ? connectText("app.reactionLimit") : null);
  items.push({
    label: messageMenuText("addReaction"),
    testId: "msg-menu-add-reaction",
    icon: "smile",
    ...lockProps(addLock),
    onClick: act((m) => opts.onReactionClick(m.id, "")),
  });
  items.push(SEPARATOR);
  return { items, group: count > 0 ? { start, count } : null };
}

/** Edit, Reply, Forward and Create Thread. */
function composeItems(ctx: MenuContext): MenuEntry[] {
  const { act, opts, gates } = ctx;
  const items: MenuEntry[] = [];
  if (gates.edit.shown) {
    items.push({
      label: messageMenuText("edit"),
      testId: "msg-menu-edit",
      icon: "pencil",
      onClick: act((m) => opts.onEditClick(m.id)),
    });
  }
  items.push({
    label: messagingText("action.reply"),
    testId: "msg-menu-reply",
    icon: "reply",
    onClick: act((m) => opts.onReplyClick(m.id)),
  });
  const onForward = opts.onForwardClick;
  if (gates.forward.shown && onForward !== undefined) {
    items.push({
      label: messageMenuText("forward"),
      testId: "msg-menu-forward",
      icon: "forward",
      ...lockProps(gates.forward.reason),
      onClick: act((m) => {
        // The socket may have dropped since the menu opened.
        if (deleteLockReason() === null) onForward(m.id);
      }),
    });
  }
  const onCreateThread = opts.onCreateThreadClick;
  if (gates.createThread.shown && onCreateThread !== undefined) {
    items.push({
      label: messageMenuText("createThread"),
      testId: "msg-menu-create-thread",
      icon: "message-square",
      ...lockProps(gates.createThread.reason),
      onClick: act((m) => {
        // The socket may have dropped since the menu opened.
        if (deleteLockReason() === null) onCreateThread(m.id);
      }),
    });
  }
  return items;
}

/** Copy (the selection), Copy Text and, on a phone, Share. */
function textItems(ctx: MenuContext, row: HTMLElement | null, phone: boolean): MenuEntry[] {
  const { act, msg } = ctx;
  const items: MenuEntry[] = [];
  const selected = selectionIn(row);
  if (selected !== "") {
    items.push({
      label: messageMenuText("copy"),
      testId: "msg-menu-copy",
      icon: "copy",
      onClick: act(() => copyText(selected)),
    });
  }
  const hasText = msg.content.trim() !== "";
  if (hasText) {
    items.push({
      label: messageMenuText("copyText"),
      testId: "msg-menu-copy-text",
      icon: "copy",
      onClick: act((m) => copyText(m.content)),
    });
  }
  // The phone's share sheet: the text, links included, to another app.
  if (phone && hasText && desktop.shareSheet.available) {
    items.push({
      label: messageMenuText("share"),
      testId: "msg-menu-share",
      icon: "share",
      onClick: act((m) => shareText(m.content)),
    });
  }
  return items;
}

/** Pin, Mark Unread and Copy Message Link. */
function placeItems(ctx: MenuContext, req: MessageMenuRequest): MenuEntry[] {
  const { act, msg, opts, gates } = ctx;
  const items: MenuEntry[] = [];
  if (gates.pin.shown) {
    items.push({
      label: msg.pinned ? messageMenuText("unpin") : messageMenuText("pin"),
      testId: "msg-menu-pin",
      icon: msg.pinned ? "pin-off" : "pin",
      onClick: act((m) => {
        // Pinned or unpinned by someone else since the label was drawn: sending
        // now would do the opposite of what the row says.
        if (m.pinned !== msg.pinned) return;
        opts.onPinClick(m.id, m.channelId, m.pinned);
      }),
    });
  }
  const markUnread = req.markUnread;
  if (markUnread !== undefined && readPointerEnabled()) {
    items.push({
      label: messageMenuText("markUnread"),
      testId: "msg-menu-mark-unread",
      icon: "mail",
      onClick: act((m) => markUnread(m.id)),
    });
  }
  items.push({
    label: messagingText("action.copyLink"),
    testId: "msg-menu-copy-message-link",
    icon: "link",
    onClick: act(() => copyMessageLink(msg)),
  });
  return items;
}

/** Delete and Report, behind a separator. */
function dangerItems(ctx: MenuContext): MenuEntry[] {
  const { act, opts, gates } = ctx;
  const items: MenuEntry[] = [];
  if (gates.delete.shown || gates.report.shown) items.push(SEPARATOR);
  if (gates.delete.shown) {
    items.push({
      label: messageMenuText("delete"),
      testId: "msg-menu-delete",
      icon: "trash-2",
      danger: true,
      ...lockProps(gates.delete.reason),
      onClick: act((m, e) => {
        // The socket may have dropped since the menu opened.
        if (deleteLockReason() !== null) return;
        opts.onDeleteClick(m.id, e.shiftKey);
      }),
    });
  }
  const onReport = opts.onReportClick;
  if (onReport !== undefined && gates.report.shown) {
    items.push({
      label: messageMenuText("report"),
      testId: "msg-menu-report",
      icon: "flag",
      danger: true,
      onClick: act((m) => onReport(m.id)),
    });
  }
  return items;
}

export function buildItems(
  req: MessageMenuRequest,
  row: HTMLElement | null,
  quickCount: number,
  phone: boolean,
): {
  items: MenuEntry[];
  group: { start: number; count: number } | null;
} {
  const { msg, opts } = req;
  const gates = messageActionGates(msg, opts);
  if (isServerRowKind(msg.kind)) return serverRowItems(msg, opts, gates);

  /** The message as it is now; null once it is gone or deleted. */
  const live = (): Message | null => {
    const found = findMessage(msg.channelId, msg.id);
    return found !== undefined && !found.deleted ? found : null;
  };
  const act: Actor = (fn) => (e) => {
    const current = live();
    if (current !== null) fn(current, e);
  };
  const ctx: MenuContext = { msg, opts, gates, act };

  const links = linkItems(ctx, req, row, phone);
  const reactions = reactionItems(ctx, quickCount, links.length);
  const items: MenuEntry[] = [
    ...links,
    ...reactions.items,
    ...composeItems(ctx),
    ...textItems(ctx, row, phone),
    ...placeItems(ctx, req),
    ...dangerItems(ctx),
  ];
  if (gates.copyId.shown) items.push(SEPARATOR, copyIdItem(msg, act));
  return { items, group: reactions.group };
}
