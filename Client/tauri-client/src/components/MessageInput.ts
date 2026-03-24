/**
 * MessageInput component — textarea with send, reply bar, and edit mode.
 * Step 5.42 of the Tauri v2 migration.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { createEmojiPicker } from "@components/EmojiPicker";
import { createGifPicker } from "@components/GifPicker";

export interface MessageInputOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onSend: (content: string, replyTo: number | null, attachments: readonly string[]) => void;
  readonly onUploadFile?: (file: File) => Promise<{ id: string; url: string; filename: string }>;
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
  let attachmentPreviewBar: HTMLDivElement | null = null;

  /** Pending attachment IDs to send with the next message. */
  const pendingAttachments: { id: string; filename: string; readonly previewEl: HTMLDivElement }[] = [];

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

  function clearPendingAttachments(): void {
    for (const att of pendingAttachments) {
      att.previewEl.remove();
    }
    pendingAttachments.length = 0;
    if (attachmentPreviewBar !== null) {
      attachmentPreviewBar.classList.remove("visible");
    }
  }

  function handleSend(): void {
    if (textarea === null) return;
    const content = textarea.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if (content.length === 0 && !hasAttachments) return;

    // Debounce to prevent double-click duplicate sends
    const now = Date.now();
    if (now - lastSendTime < SEND_DEBOUNCE_MS) return;
    lastSendTime = now;

    if (state.editing !== null) {
      options.onEditMessage(state.editing.messageId, content);
      cancelEdit();
    } else {
      // Only include attachments that have finished uploading (have a real server ID)
      const attachmentIds = pendingAttachments
        .filter((a) => !a.id.startsWith("pending-"))
        .map((a) => a.id);
      options.onSend(content, state.replyTo?.messageId ?? null, attachmentIds);
      clearReply();
      clearPendingAttachments();
    }

    textarea.value = "";
    autoResize();
    textarea.focus();
  }

  /** Unique counter for preview items (before upload completes and we have a server ID). */
  let previewCounter = 0;

  function removePreviewItem(tempId: string): void {
    const idx = pendingAttachments.findIndex((a) => a.id === tempId);
    const att = idx !== -1 ? pendingAttachments[idx] : undefined;
    if (att !== undefined) {
      const img = att.previewEl.querySelector("img");
      if (img !== null && img.src.startsWith("blob:")) {
        URL.revokeObjectURL(img.src);
      }
      att.previewEl.remove();
      pendingAttachments.splice(idx, 1);
      if (pendingAttachments.length === 0) {
        attachmentPreviewBar?.classList.remove("visible");
      }
    }
  }

  /** Read a File as a data: URL (more reliable than createObjectURL in WebView2). */
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function handlePasteFile(file: File): Promise<void> {
    if (options.onUploadFile === undefined || attachmentPreviewBar === null) return;

    const tempId = `pending-${++previewCounter}`;
    const isImage = file.type.startsWith("image/");

    attachmentPreviewBar.classList.add("visible");

    const item = createElement("div", { class: "attachment-preview-item uploading" });

    if (isImage) {
      // Read file as data URL for preview (works reliably in WebView2)
      const img = createElement("img", {
        class: "attachment-preview-img",
        alt: file.name,
      }) as HTMLImageElement;
      item.appendChild(img);
      readFileAsDataUrl(file).then((dataUrl) => {
        img.src = dataUrl;
      }).catch(() => {
        // Fallback: show filename
        const nameEl = createElement("span", { class: "attachment-preview-name" }, file.name);
        img.replaceWith(nameEl);
      });
    } else {
      const icon = createElement("div", { class: "attachment-preview-file" });
      icon.appendChild(createIcon("file-text", 16));
      const nameEl = createElement("span", { class: "attachment-preview-name" }, file.name);
      appendChildren(item, icon, nameEl);
    }

    // Loading spinner overlay
    const spinner = createElement("div", { class: "attachment-preview-spinner" });
    spinner.appendChild(createIcon("loader", 16));
    item.appendChild(spinner);

    const removeBtn = createElement("button", {
      class: "attachment-preview-remove",
      "data-testid": "attachment-remove",
    });
    removeBtn.appendChild(createIcon("x", 14));
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removePreviewItem(tempId);
    }, { signal });
    item.appendChild(removeBtn);

    attachmentPreviewBar.appendChild(item);
    pendingAttachments.push({ id: tempId, filename: file.name, previewEl: item });

    // Upload in background
    try {
      const result = await options.onUploadFile(file);
      // Replace temp ID with real server ID
      const att = pendingAttachments.find((a) => a.id === tempId);
      if (att !== undefined) {
        att.id = result.id;
        att.filename = result.filename;
        item.classList.remove("uploading");
        spinner.remove();
      }
    } catch (err) {
      // Upload failed — remove preview and show error
      removePreviewItem(tempId);
      const errMsg = err instanceof Error ? err.message : "Upload failed";
      // Show error inline since we may not have toast access here
      const errEl = createElement("div", {
        class: "attachment-upload-error",
      }, `Upload failed: ${errMsg}`);
      attachmentPreviewBar.appendChild(errEl);
      setTimeout(() => errEl.remove(), 4000);
    }
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
    const replyClose = createElement("button", { class: "reply-close" });
    replyClose.appendChild(createIcon("x", 14));
    replyClose.addEventListener("click", clearReply, { signal });
    replyInner.appendChild(replyClose);
    replyBar.appendChild(replyInner);

    editBar = createElement("div", { class: "reply-bar" });
    const editInner = createElement("div", { class: "reply-bar-inner" });
    const editText = createElement("strong", {}, "Editing message");
    editInner.appendChild(editText);
    const editClose = createElement("button", { class: "reply-close" });
    editClose.appendChild(createIcon("x", 14));
    editClose.addEventListener("click", () => cancelEdit(), { signal });
    editInner.appendChild(editClose);
    editBar.appendChild(editInner);

    attachmentPreviewBar = createElement("div", { class: "attachment-preview-bar" });

    const inputBox = createElement("div", { class: "message-input-box" });
    const attachBtn = createElement("button",
      { class: "input-btn attach-btn", "aria-label": "Attach file" }, "+");

    // File picker via attach button
    if (options.onUploadFile !== undefined) {
      const fileInput = createElement("input", {
        type: "file",
        style: "display: none;",
        accept: "image/*,video/*,audio/*,.pdf,.txt,.zip,.rar,.7z",
      }) as HTMLInputElement;
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file != null) {
          void handlePasteFile(file);
        }
        fileInput.value = "";
      }, { signal });
      attachBtn.addEventListener("click", () => fileInput.click(), { signal });
      root?.appendChild(fileInput);
    } else {
      attachBtn.setAttribute("disabled", "true");
      attachBtn.title = "File uploads not available";
    }
    textarea = createElement("textarea", {
      class: "msg-textarea", placeholder: `Message #${options.channelName}`, rows: "1",
      "data-testid": "msg-textarea",
    });
    const emojiBtn = createElement("button",
      { class: "input-btn emoji-btn", "aria-label": "Emoji" });
    emojiBtn.appendChild(createIcon("smile", 20));
    const gifBtn = createElement("button",
      { class: "input-btn gif-btn", "aria-label": "GIF" }, "GIF");
    const sendBtn = createElement("button",
      { class: "input-btn send-btn", "aria-label": "Send message", "data-testid": "send-btn" });
    sendBtn.appendChild(createIcon("send", 20));

    textarea.addEventListener("input", () => { autoResize(); maybeEmitTyping(); }, { signal });
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
      if (e.key === "Escape") {
        if (state.editing !== null) { cancelEdit(); }
        else if (state.replyTo !== null) { clearReply(); }
      }
      if (e.key === "ArrowUp" && textarea !== null && textarea.value.length === 0) {
        root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
      }
    }, { signal });

    // Clipboard paste: detect images/files
    textarea.addEventListener("paste", (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items === undefined) return;
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file === null) continue;
        e.preventDefault();
        void handlePasteFile(file);
      }
    }, { signal });

    sendBtn.addEventListener("click", handleSend, { signal });

    // Picker state (declared together so both toggle functions can cross-close)
    let emojiPicker: { element: HTMLDivElement; destroy(): void } | null = null;
    let gifPicker: { element: HTMLDivElement; destroy(): void } | null = null;

    function closeEmojiPicker(): void {
      if (emojiPicker !== null) {
        emojiPicker.element.remove();
        emojiPicker.destroy();
        emojiPicker = null;
        document.removeEventListener("mousedown", handleClickOutside);
      }
    }

    function handleClickOutside(e: MouseEvent): void {
      if (emojiPicker === null) return;
      const target = e.target as Node;
      // Close if click is outside both the picker and the emoji button
      if (!emojiPicker.element.contains(target) && target !== emojiBtn && !emojiBtn.contains(target)) {
        closeEmojiPicker();
      }
    }

    function toggleEmojiPicker(): void {
      // Close GIF picker if open
      if (gifPicker !== null) {
        closeGifPicker();
      }
      if (emojiPicker !== null) {
        closeEmojiPicker();
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
          closeEmojiPicker();
        },
        onClose: () => {
          closeEmojiPicker();
        },
      });
      root?.appendChild(emojiPicker.element);
      // Defer so this click doesn't immediately close it
      setTimeout(() => {
        document.addEventListener("mousedown", handleClickOutside);
      }, 0);
    }

    emojiBtn.addEventListener("click", toggleEmojiPicker, { signal });

    // GIF picker toggle
    function closeGifPicker(): void {
      if (gifPicker !== null) {
        gifPicker.element.remove();
        gifPicker.destroy();
        gifPicker = null;
        document.removeEventListener("mousedown", handleGifClickOutside);
      }
    }

    function handleGifClickOutside(e: MouseEvent): void {
      if (gifPicker === null) return;
      const target = e.target as Node;
      if (!gifPicker.element.contains(target) && target !== gifBtn && !gifBtn.contains(target)) {
        closeGifPicker();
      }
    }

    function toggleGifPicker(): void {
      // Close emoji picker if open
      if (emojiPicker !== null) {
        closeEmojiPicker();
      }
      if (gifPicker !== null) {
        closeGifPicker();
        return;
      }
      gifPicker = createGifPicker({
        onSelect: (gifUrl: string) => {
          if (textarea !== null) {
            textarea.value = gifUrl;
            handleSend();
          }
          closeGifPicker();
        },
        onClose: () => {
          closeGifPicker();
        },
      });
      root?.appendChild(gifPicker.element);
      setTimeout(() => {
        document.addEventListener("mousedown", handleGifClickOutside);
      }, 0);
    }

    gifBtn.addEventListener("click", toggleGifPicker, { signal });

    appendChildren(inputBox, attachBtn, textarea, emojiBtn, gifBtn, sendBtn);
    appendChildren(root, replyBar, editBar, attachmentPreviewBar, inputBox);
    container.appendChild(root);
    textarea.focus();
  }

  function destroy(): void {
    ac.abort();
    // Image previews now use data: URLs (via readFileAsDataUrl) which don't
    // require revocation — just clear the array and let GC reclaim them.
    pendingAttachments.length = 0;
    root?.remove();
    root = null;
    textarea = null;
    replyBar = null;
    replyText = null;
    editBar = null;
    attachmentPreviewBar = null;
  }

  return { mount, destroy, setReplyTo, clearReply, startEdit, cancelEdit };
}
