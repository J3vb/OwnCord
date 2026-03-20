/**
 * ReactionController — reaction toggle and emoji-picker positioning logic.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { createElement } from "@lib/dom";
import { createEmojiPicker } from "@components/EmojiPicker";
import { getChannelMessages } from "@stores/messages.store";
import type { WsClient } from "@lib/ws";

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

export function createReactionController(
  opts: ReactionControllerOptions,
): ReactionController {
  const { ws, reactionsLimiter, getChannelId, showError } = opts;

  function sendReaction(msgId: number, emoji: string): void {
    if (!reactionsLimiter.tryConsume()) {
      showError("Slow down! Please wait before reacting again.");
      return;
    }
    const msgs = getChannelMessages(getChannelId());
    const msg = msgs.find((m) => m.id === msgId);
    const existing = msg?.reactions.find((r) => r.emoji === emoji);
    const type = existing?.me ? "reaction_remove" : "reaction_add";
    ws.send({ type, payload: { message_id: msgId, emoji } });
  }

  let activePickerDestroy: (() => void) | null = null;

  function closePicker(): void {
    activePickerDestroy?.();
    activePickerDestroy = null;
    const wrap = document.querySelector(".reaction-picker-wrap");
    if (wrap !== null) wrap.remove();
  }

  function openPicker(msgId: number): void {
    const reactBtn = document.querySelector(
      `[data-testid="msg-react-${msgId}"]`,
    );
    if (reactBtn === null) return;

    // Close any existing reaction picker (including proper cleanup)
    const existingWrap = document.querySelector(".reaction-picker-wrap");
    if (existingWrap !== null) {
      closePicker();
      return;
    }

    const wrap = createElement("div", { class: "reaction-picker-wrap" });

    // Backdrop to close on click-outside
    const backdrop = createElement("div", {
      style: "position: fixed; inset: 0; z-index: 299;",
    });
    backdrop.addEventListener("click", () => {
      closePicker();
    });

    const picker = createEmojiPicker({
      onSelect: (selectedEmoji: string) => {
        closePicker();
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
