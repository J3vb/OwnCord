/**
 * The message right-click menu: quick reactions, Add Reaction, Edit, Reply, Forward,
 * Create Thread, Copy / Copy Text, Pin, Copy Message Link, Delete, Report and (in developer
 * mode) Copy Message ID, with Copy Link / Open Link first on a link.
 *
 * Which actions show, and which are locked, comes from `messageActionGates`
 * (the hover bar's own gates). Every action goes through the same
 * `MessageListOptions` callbacks as the hover bar, and re-reads the message
 * first: a menu left open while the message was deleted does nothing.
 *
 * Lazy: message-menu-loader.ts imports it on the first right-click, so the
 * menu and its copy stay out of the main-page chunk.
 */

import {
  showContextMenu,
  type ContextMenuItem,
  type ContextMenuSeparator,
} from "@lib/context-menu";
import { Disposable } from "@lib/disposable";
import { readPointerEnabled } from "@lib/serverCapabilities";
import { wantsNativeMenu } from "@lib/dom";
import type { Message } from "@stores/messages.store";
import { isServerRowKind } from "@lib/text/messageKind";

import { QUICK_REACTIONS, emojiNode, quickReactionEmoji } from "./quick-reactions";
import type { MessageListOptions } from "../MessageList";
import { connectText } from "../../i18n/connect";
import { imageMenuText } from "../../i18n/imageMenu";
import { messageMenuText } from "../../i18n/messageMenu";
import { copyWithToast } from "../../features/developer-mode/developerTools";
import { messagingText } from "../../i18n/messaging";
import {
  ROW_FOCUSABLE_SELECTOR,
  deleteLockReason,
  findMessage,
  copyMessageLink,
  isActionableMessage,
  messageActionGates,
} from "./message-actions";
import { atReactionLimit } from "./reactions";
import { copyThenToast } from "@lib/clipboard";

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

let menuOwner: Disposable | null = null;

/** Close the open message menu, if any. */
export function closeMessageMenu(): void {
  menuOwner?.destroy();
  menuOwner = null;
}

function rowOf(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="message-${id}"]`);
}

function copyText(text: string): void {
  copyThenToast(text, messageMenuText("copied"), messageMenuText("copyFailed"));
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

function buildItems(
  req: MessageMenuRequest,
  row: HTMLElement | null,
): {
  items: (ContextMenuItem | ContextMenuSeparator)[];
  group: { start: number; count: number } | null;
} {
  const { msg, opts, target } = req;
  const gates = messageActionGates(msg, opts);
  const items: (ContextMenuItem | ContextMenuSeparator)[] = [];
  const sep: ContextMenuSeparator = { separator: true };

  // A server row (call log, group event) offers nothing but Copy ID (developer
  // mode); a pin row also offers Delete when the viewer may delete it.
  if (isServerRowKind(msg.kind)) {
    if (gates.copyId.shown) {
      items.push({
        label: messageMenuText("copyId"),
        testId: "msg-menu-copy-id",
        onClick: () => copyWithToast(String(msg.id), "toast.idCopied", "toast.idCopyFailed"),
      });
    }
    if (gates.delete.shown) {
      if (items.length > 0) items.push(sep);
      items.push({
        label: messageMenuText("delete"),
        testId: "msg-menu-delete",
        danger: true,
        disabled: gates.delete.disabled,
        ...(gates.delete.reason !== null ? { title: gates.delete.reason } : {}),
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

  /** The message as it is now; null once it is gone or deleted. */
  const live = (): Message | null => {
    const found = findMessage(msg.channelId, msg.id);
    return found !== undefined && !found.deleted ? found : null;
  };
  const act =
    (fn: (current: Message, e: MouseEvent) => void) =>
    (e: MouseEvent): void => {
      const current = live();
      if (current !== null) fn(current, e);
    };

  // -- Link under the pointer ------------------------------------------------
  const anchor = target?.closest<HTMLAnchorElement>('.msg-text a[href^="http"]') ?? null;
  const href = anchor?.getAttribute("href") ?? null;
  if (anchor !== null && href !== null) {
    items.push(
      {
        label: imageMenuText("copyLink"),
        testId: "msg-menu-copy-link",
        onClick: act(() => {
          copyThenToast(href, imageMenuText("linkCopied"), imageMenuText("linkCopyFailed"));
        }),
      },
      {
        label: imageMenuText("openLink"),
        testId: "msg-menu-open-link",
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
      sep,
    );
  }

  // -- Reactions ---------------------------------------------------------------
  const reactLock = gates.react.reason;
  const group: { start: number; count: number } = { start: items.length, count: 0 };
  for (const emoji of quickReactionEmoji(QUICK_REACTIONS)) {
    if (atReactionLimit(msg.reactions, emoji)) continue;
    const { node, name } = emojiNode(emoji);
    items.push({
      label: messagingText("action.reactWith", { name }),
      content: node,
      testId: `msg-menu-quick-${emoji}`,
      disabled: reactLock !== null,
      ...(reactLock !== null ? { title: reactLock } : {}),
      onClick: act((m) => opts.onReactionClick(m.id, emoji)),
    });
    group.count++;
  }
  const full = atReactionLimit(msg.reactions, null);
  const addLock = reactLock ?? (full ? connectText("app.reactionLimit") : null);
  items.push({
    label: messageMenuText("addReaction"),
    testId: "msg-menu-add-reaction",
    disabled: addLock !== null,
    ...(addLock !== null ? { title: addLock } : {}),
    onClick: act((m) => opts.onReactionClick(m.id, "")),
  });
  items.push(sep);

  // -- Message ----------------------------------------------------------------
  if (gates.edit.shown) {
    items.push({
      label: messageMenuText("edit"),
      testId: "msg-menu-edit",
      onClick: act((m) => opts.onEditClick(m.id)),
    });
  }
  items.push({
    label: messagingText("action.reply"),
    testId: "msg-menu-reply",
    onClick: act((m) => opts.onReplyClick(m.id)),
  });
  const onForward = opts.onForwardClick;
  if (gates.forward.shown && onForward !== undefined) {
    items.push({
      label: messageMenuText("forward"),
      testId: "msg-menu-forward",
      disabled: gates.forward.disabled,
      ...(gates.forward.reason !== null ? { title: gates.forward.reason } : {}),
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
      disabled: gates.createThread.disabled,
      ...(gates.createThread.reason !== null ? { title: gates.createThread.reason } : {}),
      onClick: act((m) => {
        // The socket may have dropped since the menu opened.
        if (deleteLockReason() === null) onCreateThread(m.id);
      }),
    });
  }
  const selected = selectionIn(row);
  if (selected !== "") {
    items.push({
      label: messageMenuText("copy"),
      testId: "msg-menu-copy",
      onClick: act(() => copyText(selected)),
    });
  }
  if (msg.content.trim() !== "") {
    items.push({
      label: messageMenuText("copyText"),
      testId: "msg-menu-copy-text",
      onClick: act((m) => copyText(m.content)),
    });
  }
  if (gates.pin.shown) {
    items.push({
      label: msg.pinned ? messageMenuText("unpin") : messageMenuText("pin"),
      testId: "msg-menu-pin",
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
      onClick: act((m) => markUnread(m.id)),
    });
  }
  items.push({
    label: messagingText("action.copyLink"),
    testId: "msg-menu-copy-message-link",
    onClick: act(() => copyMessageLink(msg)),
  });

  // -- Danger -----------------------------------------------------------------
  if (gates.delete.shown || gates.report.shown) items.push(sep);
  if (gates.delete.shown) {
    items.push({
      label: messageMenuText("delete"),
      testId: "msg-menu-delete",
      danger: true,
      disabled: gates.delete.disabled,
      ...(gates.delete.reason !== null ? { title: gates.delete.reason } : {}),
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
      danger: true,
      onClick: act((m) => onReport(m.id)),
    });
  }

  if (gates.copyId.shown) {
    items.push(sep, {
      label: messageMenuText("copyId"),
      testId: "msg-menu-copy-id",
      onClick: act(() => copyWithToast(String(msg.id), "toast.idCopied", "toast.idCopyFailed")),
    });
  }
  return { items, group: group.count > 0 ? group : null };
}

/** A `contextmenu` event on a message list, as the list hands it over. */
export interface MessageMenuAt {
  readonly opts: MessageListOptions;
  readonly x: number;
  readonly y: number;
  readonly target: EventTarget | null;
  readonly signal: AbortSignal;
  readonly markUnread?: (messageId: number) => void;
}

/** What an Alt+click marks unread must not be: a control with an action of its own. */
const OWN_ACTION_SELECTOR =
  "a, button, input, textarea, select, img, video, audio, [role='button'], " +
  ".msg-author, .msg-avatar, .mention, .message-link-chip, .spoiler";

/**
 * Alt+click on a message row: mark it unread. Does nothing on a link, button,
 * image, text field or another control with its own click, nor on a row that
 * is not a confirmed server message (pending, failed, deleted, system).
 */
export function markUnreadAt(at: {
  readonly opts: MessageListOptions;
  readonly target: EventTarget | null;
  readonly markUnread: (messageId: number) => void;
}): void {
  const target = at.target instanceof Element ? at.target : null;
  if (target === null || wantsNativeMenu(target) || target.closest(OWN_ACTION_SELECTOR) !== null) {
    return;
  }
  const row = target.closest<HTMLElement>('.message[data-testid^="message-"]');
  const id = Number(row?.dataset["testid"]?.slice("message-".length));
  const msg = findMessage(at.opts.channelId, id);
  if (msg === undefined || msg.user.id === 0 || !isActionableMessage(msg)) return;
  at.markUnread(msg.id);
}

/**
 * Open the menu for the message row `at.target` is in. Opens nothing for a
 * text field (it keeps the webview's own menu with spelling suggestions), for a
 * target outside any row, or for a row that is not a confirmed server message
 * (pending, failed, deleted, system).
 */
export function openMessageMenuAt(at: MessageMenuAt): void {
  const target = at.target instanceof Element ? at.target : null;
  if (wantsNativeMenu(target)) return;
  const row = target?.closest<HTMLElement>('.message[data-testid^="message-"]');
  const id = Number(row?.dataset["testid"]?.slice("message-".length));
  const msg = findMessage(at.opts.channelId, id);
  // System rows (user 0) are drawn by another renderer and offer nothing.
  if (msg === undefined || msg.user.id === 0 || !isActionableMessage(msg)) return;
  openMessageMenu({ ...at, msg, target });
}

/**
 * Open the menu from a hover bar's "..." button, below and left-aligned with
 * it (Discord's placement). The list's own signal owns the menu, so a row
 * patch or a virtual-scroll rebuild of the row does not close it. Opens
 * nothing for a row that is not a confirmed server message.
 */
export function openMessageMenuFromButton(at: {
  readonly opts: MessageListOptions;
  readonly button: HTMLElement;
  readonly signal: AbortSignal;
  readonly markUnread?: (messageId: number) => void;
}): void {
  const row = at.button.closest<HTMLElement>('.message[data-testid^="message-"]');
  const id = Number(row?.dataset["testid"]?.slice("message-".length));
  const msg = findMessage(at.opts.channelId, id);
  if (msg === undefined || msg.user.id === 0 || !isActionableMessage(msg)) return;
  const rect = at.button.getBoundingClientRect();
  openMessageMenu({
    msg,
    opts: at.opts,
    x: rect.left,
    y: rect.bottom,
    target: null,
    signal: at.signal,
    invoker: at.button,
    ...(at.markUnread !== undefined ? { markUnread: at.markUnread } : {}),
  });
}

/**
 * Open the menu for `req.msg`. Opens nothing for a row that is not a confirmed
 * server message, or one that vanished while the module loaded.
 */
export function openMessageMenu(req: MessageMenuRequest): void {
  const { msg, signal, invoker } = req;
  if (signal.aborted) return;
  const current = findMessage(msg.channelId, msg.id);
  if (current === undefined || current.deleted) return;
  // Nothing to offer on a server row outside developer mode: no empty menu.
  if (isServerRowKind(current.kind)) {
    const serverGates = messageActionGates(current, req.opts);
    if (!serverGates.copyId.shown && !serverGates.delete.shown) return;
  }
  closeMessageMenu();

  const row = rowOf(msg.id);
  let { x, y } = req;
  if (x === 0 && y === 0 && row !== null) {
    // A keyboard open has no pointer: anchor where the hover bar sits.
    const rect = row.getBoundingClientRect();
    x = rect.right;
    y = rect.top;
  }

  const owner = new Disposable();
  menuOwner = owner;
  signal.addEventListener("abort", () => owner.destroy(), { once: true, signal: owner.signal });
  invoker?.setAttribute("aria-expanded", "true");
  owner.addCleanup(() => {
    invoker?.setAttribute("aria-expanded", "false");
    if (menuOwner === owner) menuOwner = null;
    // A programmatic close (another menu, the list's signal) has no Escape to
    // restore focus: give it back unless something else already took it.
    const active = document.activeElement;
    if (invoker?.isConnected === true && (active === null || active === document.body)) {
      invoker.focus();
    }
  });

  const { items, group } = buildItems(req, row);
  showContextMenu({
    x,
    y,
    items,
    ...(group !== null ? { group } : {}),
    signal: owner.signal,
    className: "message-context-menu",
    ariaLabel: messageMenuText("label"),
    groupLabel: messageMenuText("quickReactions"),
    // Virtual scrolling may replace the control that held focus: return to the
    // invoker, else to the rebuilt row's first control.
    restoreFocusTo: () =>
      invoker?.isConnected === true
        ? invoker
        : ((invoker !== undefined
            ? rowOf(msg.id)?.querySelector<HTMLElement>(`[data-testid="msg-more-${msg.id}"]`)
            : null) ??
          rowOf(msg.id)?.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR) ??
          null),
    onClosed: () => owner.destroy(),
  });
}
