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
 *
 * On a phone the same rows open as a bottom sheet (messageSheet.ts) instead.
 */

import { showContextMenu } from "@lib/ui/contextMenu";
import { Disposable } from "@lib/disposable";
import { wantsNativeMenu } from "@lib/dom";
import { isServerRowKind } from "@lib/text/messageKind";

import { QUICK_REACTIONS } from "./quickReactions";
import type { MessageListOptions } from "../MessageList";
import { messageMenuText } from "../../../i18n/messageMenu";
import {
  ROW_FOCUSABLE_SELECTOR,
  findMessage,
  isActionableMessage,
  messageActionGates,
} from "./messageActions";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { openMessageSheet } from "./messageSheet";
import { buildItems, rowOf, type MessageMenuRequest } from "./messageMenuItems";

export type { MessageMenuRequest } from "./messageMenuItems";

/** The phone sheet's quick row has room for one more emoji than the menu's. */
const PHONE_QUICK_REACTIONS = QUICK_REACTIONS + 1;
/** Marks the row a phone sheet is acting on, so it stands out behind the backdrop. */
const SHEET_TARGET_CLASS = "msg-sheet-target";

let menuOwner: Disposable | null = null;

/** Close the open message menu, if any. */
export function closeMessageMenu(): void {
  menuOwner?.destroy();
  menuOwner = null;
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

  if (isPhoneLayout()) {
    const { items, group } = buildItems(req, row, PHONE_QUICK_REACTIONS, true);
    row?.classList.add(SHEET_TARGET_CLASS);
    owner.addCleanup(() => rowOf(msg.id)?.classList.remove(SHEET_TARGET_CLASS));
    openMessageSheet({
      items,
      group,
      label: messageMenuText("label"),
      groupLabel: messageMenuText("quickReactions"),
      signal: owner.signal,
      fallbackFocus: () =>
        rowOf(msg.id)?.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR) ?? null,
      onClosed: () => owner.destroy(),
    });
    return;
  }

  const { items, group } = buildItems(req, row, QUICK_REACTIONS, false);
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
