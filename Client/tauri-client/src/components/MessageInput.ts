/**
 * MessageInput component — textarea with send, reply bar, and edit mode.
 * Step 5.42 of the Tauri v2 migration.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { createEmojiPicker } from "@components/EmojiPicker";

export interface MessageInputOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onSend: (content: string, replyTo: number | null) => void;
  readonly onTyping: () => void;
  readonly onEditMessage: (messageId: number, content: string) => void;
}

export type MessageInputComponent = MountableComponent & {
  setReplyTo(messageId: number, username: string): void;
  clearReply(): void;
  startEdit(messageId: number, content: string): void;
  cancelEdit(): void;
};

const TYPING_THROTTLE_MS = 3_000;
const MAX_TEXTAREA_HEIGHT = 200;
const SEND_DEBOUNCE_MS = 200;

export function createMessageInput(
  options: MessageInputOptions,
): MessageInputComponent {
  const ac = new AbortController();
  const signal = ac.signal;
  let root: HTMLDivElement | null = null;
  let state = { replyTo: null as { messageId: number; username: string } | null,
    editing: null as { messageId: number } | null };
  let lastTypingTime = 0;
  let lastSendTime = 0;

  let textarea: HTMLTextAreaElement | null = null;
  let replyBar: HTMLDivElement | null = null;
  let replyText: HTMLSpanElement | null = null;
  let editBar: HTMLDivElement | null = null;

  function showReplyBar(username: string): void {
    if (replyBar === null || replyText === null) return;
    setText(replyText, `Replying to @${username}`);
    replyBar.classList.add("visible");
  }

  function hideReplyBar(): void { replyBar?.classList.remove("visible"); }
  function showEditBar(): void { editBar?.classList.add("visible"); }
  function hideEditBar(): void { editBar?.classList.remove("visible"); }

  function autoResize(): void {
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  function maybeEmitTyping(): void {
    const now = Date.now();
    if (now - lastTypingTime >= TYPING_THROTTLE_MS) {
      lastTypingTime = now;
      options.onTyping();
    }
  }

  function handleSend(): void {
    if (textarea === null) return;
    const content = textarea.value.trim();
    if (content.length === 0) return;

    // Debounce to prevent double-click duplicate sends
    const now = Date.now();
    if (now - lastSendTime < SEND_DEBOUNCE_MS) return;
    lastSendTime = now;

    if (state.editing !== null) {
      options.onEditMessage(state.editing.messageId, content);
      cancelEdit();
    } else {
      options.onSend(content, state.replyTo?.messageId ?? null);
      clearReply();
    }

    textarea.value = "";
    autoResize();
    textarea.focus();
  }

  function setReplyTo(messageId: number, username: string): void {
    if (state.editing !== null) hideEditBar();
    state = { replyTo: { messageId, username }, editing: null };
    showReplyBar(username);
    textarea?.focus();
  }

  function clearReply(): void {
    state = { ...state, replyTo: null };
    hideReplyBar();
  }

  function startEdit(messageId: number, content: string): void {
    if (state.replyTo !== null) hideReplyBar();
    state = { replyTo: null, editing: { messageId } };
    showEditBar();
    if (textarea !== null) {
      textarea.value = content;
      autoResize();
      textarea.focus();
    }
  }

  function cancelEdit(): void {
    state = { ...state, editing: null };
    hideEditBar();
    if (textarea !== null) { textarea.value = ""; autoResize(); }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "message-input-wrap", "data-testid": "message-input" });

    replyBar = createElement("div", { class: "reply-bar" });
    const replyInner = createElement("div", { class: "reply-bar-inner" });
    replyText = createElement("strong", {});
    replyInner.appendChild(replyText);
    const replyClose = createElement("button", { class: "reply-close" }, "\u00D7");
    replyClose.addEventListener("click", clearReply, { signal });
    replyInner.appendChild(replyClose);
    replyBar.appendChild(replyInner);

    editBar = createElement("div", { class: "reply-bar" });
    const editInner = createElement("div", { class: "reply-bar-inner" });
    const editText = createElement("strong", {}, "Editing message");
    editInner.appendChild(editText);
    const editClose = createElement("button", { class: "reply-close" }, "\u00D7");
    editClose.addEventListener("click", () => cancelEdit(), { signal });
    editInner.appendChild(editClose);
    editBar.appendChild(editInner);

    const inputBox = createElement("div", { class: "message-input-box" });
    const attachBtn = createElement("button",
      { class: "input-btn attach-btn", "aria-label": "Attach file" }, "+");
    textarea = createElement("textarea", {
      class: "msg-textarea", placeholder: `Message #${options.channelName}`, rows: "1",
      "data-testid": "msg-textarea",
    });
    const emojiBtn = createElement("button",
      { class: "input-btn emoji-btn", "aria-label": "Emoji" }, "\uD83D\uDE00");
    const sendBtn = createElement("button",
      { class: "input-btn send-btn", "aria-label": "Send message", "data-testid": "send-btn" }, "\u27A4");

    textarea.addEventListener("input", () => { autoResize(); maybeEmitTyping(); }, { signal });
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
      if (e.key === "ArrowUp" && textarea !== null && textarea.value.length === 0) {
        root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
      }
    }, { signal });

    sendBtn.addEventListener("click", handleSend, { signal });

    // Emoji picker toggle
    let emojiPicker: { element: HTMLDivElement; destroy(): void } | null = null;

    function toggleEmojiPicker(): void {
      if (emojiPicker !== null) {
        emojiPicker.element.remove();
        emojiPicker.destroy();
        emojiPicker = null;
        return;
      }
      emojiPicker = createEmojiPicker({
        onSelect: (emoji: string) => {
          if (textarea !== null) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const before = textarea.value.slice(0, start);
            const after = textarea.value.slice(end);
            textarea.value = before + emoji + after;
            textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
            textarea.focus();
          }
          // Close after selection
          if (emojiPicker !== null) {
            emojiPicker.element.remove();
            emojiPicker.destroy();
            emojiPicker = null;
          }
        },
        onClose: () => {
          if (emojiPicker !== null) {
            emojiPicker.element.remove();
            emojiPicker.destroy();
            emojiPicker = null;
          }
        },
      });
      root?.appendChild(emojiPicker.element);
    }

    emojiBtn.addEventListener("click", toggleEmojiPicker, { signal });

    appendChildren(inputBox, attachBtn, textarea, emojiBtn, sendBtn);
    appendChildren(root, replyBar, editBar, inputBox);
    container.appendChild(root);
    textarea.focus();
  }

  function destroy(): void {
    ac.abort();
    root?.remove();
    root = null;
    textarea = null;
    replyBar = null;
    replyText = null;
    editBar = null;
  }

  return { mount, destroy, setReplyTo, clearReply, startEdit, cancelEdit };
}
