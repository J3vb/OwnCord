/**
 * ReactionController — reaction toggle and emoji-picker positioning logic.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { createElement } from "@lib/dom";
import { isPhoneLayout, openBottomSheet } from "@lib/ui/bottomSheet";
import { createLazyScreen } from "@components/lazyScreen";
import {
  atReactionLimit,
  channelCanReact,
  reactionLockReason,
} from "@components/message-list/reactions";
import { addOptimisticReaction, getChannelMessages } from "@stores/messages.store";
import { listCustomEmoji } from "@stores/emoji.store";
import type { WsClient } from "@lib/ws";
import { shellText } from "../../i18n/shell";
import { connectText } from "../../i18n/connect";
import { messagingText } from "../../i18n/messaging";

// The picker loads on its first open, so its code stays out of the main-page chunk.
const emojiPickerScreen = createLazyScreen("emoji-picker", () => import("@components/EmojiPicker"));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReactionControllerOptions {
  readonly ws: WsClient;
  readonly reactionsLimiter: { tryConsume(): boolean };
  readonly getChannelId: () => number;
  readonly showError: (msg: string) => void;
}

export interface ReactionController {
  /** Handle a reaction click — toggles existing emoji or opens picker when emoji is "". */
  handleReaction(msgId: number, emoji: string): void;
  /** Remove any open reaction picker from the DOM. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReactionController(opts: ReactionControllerOptions): ReactionController {
  const { ws, reactionsLimiter, getChannelId, showError } = opts;

  function sendReaction(msgId: number, emoji: string): void {
    // A picker opened before the socket dropped must not send into the void.
    const channelId = getChannelId();
    const locked = reactionLockReason(channelCanReact(channelId));
    if (locked !== null) {
      showError(locked);
      return;
    }
    const msgs = getChannelMessages(channelId);
    const msg = msgs.find((m) => m.id === msgId);
    if (msg !== undefined && atReactionLimit(msg.reactions, emoji)) {
      showError(connectText("app.reactionLimit"));
      return;
    }
    if (!reactionsLimiter.tryConsume()) {
      showError(shellText("messages.reactionSlowDown"));
      return;
    }
    const existing = msg?.reactions.find((r) => r.emoji === emoji);
    const action = existing?.me ? ("remove" as const) : ("add" as const);
    const type = action === "remove" ? "reaction_remove" : "reaction_add";
    const correlationId = ws.send({ type, payload: { message_id: msgId, emoji } });
    // Optimistic toggle (ux/messaging §5): the pill flips on the click; the
    // server echo is consumed rather than re-applied, and an error reply (or
    // transport failure) rolls back exactly this toggle via its envelope id.
    addOptimisticReaction(correlationId, { channelId, messageId: msgId, emoji, action });
  }

  let activePickerDestroy: (() => void) | null = null;
  let activeSheetClose: (() => void) | null = null;

  // Set while the picker's code loads. A click on the same message's react
  // button cancels it (the button toggles), as does any close or destroy().
  let pendingPicker: { readonly ticket: object; readonly msgId: number } | null = null;

  function closePicker(): void {
    pendingPicker = null;
    activePickerDestroy?.();
    activePickerDestroy = null;
    const sheetClose = activeSheetClose;
    activeSheetClose = null;
    sheetClose?.();
    const wrap = document.querySelector(".reaction-picker-wrap");
    if (wrap !== null) wrap.remove();
  }

  function openPicker(msgId: number): void {
    // A phone opens the picker in a sheet, so it needs no hover-bar button to sit by.
    const reactBtn = document.querySelector(`[data-testid="msg-react-${msgId}"]`);
    if (reactBtn === null && !isPhoneLayout()) return;

    // Close any existing reaction picker (including proper cleanup). A picker
    // on the SAME message toggles closed and returns; one on a DIFFERENT
    // message is replaced by the new one rather than swallowing the click.
    if (pendingPicker !== null) {
      const sameMessage = pendingPicker.msgId === msgId;
      pendingPicker = null;
      if (sameMessage) return;
    }
    if (activeSheetClose !== null) closePicker();
    const existingWrap = document.querySelector(".reaction-picker-wrap");
    if (existingWrap !== null) {
      const sameMessage = existingWrap.getAttribute("data-message-id") === String(msgId);
      closePicker();
      if (sameMessage) return;
    }

    const msg = getChannelMessages(getChannelId()).find((m) => m.id === msgId);
    if (msg !== undefined && atReactionLimit(msg.reactions, null)) {
      showError(connectText("app.reactionLimit"));
      return;
    }

    const ticket = {};
    pendingPicker = { ticket, msgId };
    void emojiPickerScreen
      .load(() => pendingPicker?.ticket === ticket)
      .then((screen) => {
        if (pendingPicker?.ticket !== ticket) return;
        pendingPicker = null;
        if (screen !== null) mountPicker(screen, msgId);
      });
  }

  function mountPickerSheet(screen: typeof import("@components/EmojiPicker"), msgId: number): void {
    const picker = screen.createEmojiPicker({
      customEmoji: listCustomEmoji(),
      onSelect: (selectedEmoji: string, select) => {
        if (select?.keepOpen !== true) closePicker();
        sendReaction(msgId, selectedEmoji);
      },
      onClose: () => {
        closePicker();
      },
    });
    activePickerDestroy = picker.destroy;
    picker.element.classList.add("in-sheet");
    const sheet = openBottomSheet({
      label: messagingText("action.react"),
      content: picker.element,
      size: "tall",
      className: "picker-sheet",
      testId: "reaction-picker-sheet",
      focusFirst: false,
      onClosed: () => {
        if (activeSheetClose !== sheet.close) return;
        activeSheetClose = null;
        closePicker();
      },
    });
    activeSheetClose = sheet.close;
  }

  function mountPicker(screen: typeof import("@components/EmojiPicker"), msgId: number): void {
    if (isPhoneLayout()) {
      mountPickerSheet(screen, msgId);
      return;
    }
    // The row may have re-rendered or gone while the code loaded.
    const reactBtn = document.querySelector(`[data-testid="msg-react-${msgId}"]`);
    if (reactBtn === null) return;
    const wrap = createElement("div", { class: "reaction-picker-wrap" });
    wrap.setAttribute("data-message-id", String(msgId));

    // Backdrop to close on click-outside
    const backdrop = createElement("div", {
      style: "position: fixed; inset: 0; z-index: 299;",
    });
    backdrop.addEventListener("click", () => {
      closePicker();
    });

    const picker = screen.createEmojiPicker({
      // Read the set at open time, not at controller construction: an
      // emoji_update while the app is alive must be in the next picker the
      // user opens (matches MessageInput.ts's composer picker).
      customEmoji: listCustomEmoji(),
      onSelect: (selectedEmoji: string, select) => {
        // Shift-pick sends the reaction and leaves the picker up for more.
        if (select?.keepOpen !== true) closePicker();
        sendReaction(msgId, selectedEmoji);
      },
      onClose: () => {
        closePicker();
      },
    });
    activePickerDestroy = picker.destroy;

    // Position the picker to the left of the react button, top-aligned
    const PICKER_WIDTH = 320;
    const PICKER_HEIGHT_ESTIMATE = 420;
    const EDGE_MARGIN = 8;

    const rect = reactBtn.getBoundingClientRect();
    let left = rect.left - PICKER_WIDTH - EDGE_MARGIN;
    let top = rect.top;
    if (left < EDGE_MARGIN) left = rect.right + EDGE_MARGIN;
    if (top + PICKER_HEIGHT_ESTIMATE > window.innerHeight - EDGE_MARGIN) {
      top = window.innerHeight - PICKER_HEIGHT_ESTIMATE - EDGE_MARGIN;
    }
    if (top < EDGE_MARGIN) top = EDGE_MARGIN;

    // Override the picker's default absolute positioning
    picker.element.style.position = "fixed";
    picker.element.style.left = `${left}px`;
    picker.element.style.top = `${top}px`;
    picker.element.style.bottom = "auto";
    picker.element.style.right = "auto";
    picker.element.style.zIndex = "300";
    picker.element.style.margin = "0";

    wrap.appendChild(backdrop);
    wrap.appendChild(picker.element);
    document.body.appendChild(wrap);
  }

  function handleReaction(msgId: number, emoji: string): void {
    if (emoji === "") {
      openPicker(msgId);
    } else {
      sendReaction(msgId, emoji);
    }
  }

  function destroy(): void {
    closePicker();
  }

  return { handleReaction, destroy };
}
