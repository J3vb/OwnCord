/**
 * MessageInput component — textarea with send, reply bar, and edit mode.
 * Step 5.42 of the Tauri v2 migration.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { createEmojiPicker } from "@components/EmojiPicker";
import { createGifPicker } from "@components/GifPicker";
import {
  createMentionAutocomplete,
  type MentionAutocompleteComponent,
} from "@components/MentionAutocomplete";
import {
  createEmojiAutocomplete,
  MIN_EMOJI_QUERY,
  type EmojiAutocompleteComponent,
} from "@components/EmojiAutocomplete";
import { listCustomEmoji } from "@stores/emoji.store";
import type { GifApi } from "@lib/gifProvider";

export interface MessageInputOptions {
  readonly channelId: number;
  readonly channelName: string;
  /**
   * GIF endpoints on the user's own server. Omit to hide the GIF affordance
   * entirely — the button is rendered disabled rather than offering a picker
   * that cannot load.
   */
  readonly gifApi?: GifApi;
  readonly onSend: (
    content: string,
    replyTo: number | null,
    attachments: readonly string[],
  ) => void;
  readonly onUploadFile?: (file: File) => Promise<{ id: string; url: string; filename: string }>;
  readonly onTyping: () => void;
  readonly onEditMessage: (messageId: number, content: string) => void;
  /** Initial disabled reason (e.g. read-only / no-permission / offline). */
  readonly disabledReason?: string | null;
}

export type MessageInputComponent = MountableComponent & {
  setReplyTo(messageId: number, username: string): void;
  clearReply(): void;
  startEdit(messageId: number, content: string): void;
  cancelEdit(): void;
  /**
   * Disable the composer with a visible reason (permission / connection), or
   * pass null to re-enable. Permission is expressed as affordance: a send that
   * the server would refuse is prevented here, not attempted and rejected.
   */
  setDisabled(reason: string | null): void;
  /**
   * Open the attachment file picker, as the "+" button does. Backs the
   * Ctrl+U shortcut. No-op while the composer is disabled or when the host
   * didn't wire an upload handler.
   */
  openFilePicker(): void;
};

/** Ctrl/Cmd shortcut → markdown marker it wraps the selection in. */
const FORMAT_MARKERS: Readonly<Record<string, string>> = {
  b: "**",
  i: "*",
  u: "__",
};

export interface WrapResult {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * Wrap (or unwrap) `[start, end)` of `value` in `marker`, returning the new
 * value and where the selection should land. With an empty selection the
 * markers are inserted around the caret so typing continues inside them.
 *
 * Pure so the behaviour can be tested without a DOM selection.
 */
export function wrapWithMarker(
  value: string,
  start: number,
  end: number,
  marker: string,
): WrapResult {
  const selected = value.slice(start, end);
  const len = marker.length;

  // Already wrapped — pressing the shortcut again takes the markers back off.
  // The interior must not itself contain the marker: otherwise a selection
  // that merely starts and ends with it (e.g. multiple already-wrapped spans,
  // or a longer marker like "**" matching the outer edge of "*x*") would be
  // mistaken for a single wrapped span and have its interior markers stripped.
  if (
    selected.length > 2 * len &&
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    !selected.slice(len, selected.length - len).includes(marker)
  ) {
    const inner = selected.slice(len, selected.length - len);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  if (value.slice(start - len, start) === marker && value.slice(end, end + len) === marker) {
    return {
      value: value.slice(0, start - len) + selected + value.slice(end + len),
      selectionStart: start - len,
      selectionEnd: start - len + selected.length,
    };
  }

  return {
    value: value.slice(0, start) + marker + selected + marker + value.slice(end),
    selectionStart: start + len,
    selectionEnd: start + len + selected.length,
  };
}

const TYPING_THROTTLE_MS = 3_000;
const MAX_TEXTAREA_HEIGHT = 200;
const SEND_DEBOUNCE_MS = 200;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB matches server limit
const ALLOWED_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/",
  "application/zip",
  "application/x-zip-compressed",
  "application/json",
];

/**
 * Keys that move the caret without an open autocomplete popup claiming them,
 * so the popup has to be resynced against the new caret on keyup. The popup's
 * own keys are deliberately absent: it consumes ArrowUp/ArrowDown/Enter/Tab
 * (so the caret does not move) and Escape closes it, and resyncing after any
 * of those would reset the highlighted row or reopen what Escape dismissed.
 */
const CARET_MOVE_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Disable the GIF button and say why, instead of silently doing nothing. */
function markGifUnavailable(gifBtn: HTMLButtonElement, reason: string): void {
  gifBtn.setAttribute("disabled", "true");
  gifBtn.title = reason;
  gifBtn.setAttribute("aria-label", `GIF — ${reason}`);
}

export function createMessageInput(options: MessageInputOptions): MessageInputComponent {
  const ac = new AbortController();
  const signal = ac.signal;
  let root: HTMLDivElement | null = null;
  let state = {
    replyTo: null as { messageId: number; username: string } | null,
    editing: null as { messageId: number } | null,
  };
  let lastTypingTime = 0;
  let lastSendTime = 0;

  let textarea: HTMLTextAreaElement | null = null;
  let replyBar: HTMLDivElement | null = null;
  let replyText: HTMLSpanElement | null = null;
  let editBar: HTMLDivElement | null = null;
  let disabledReason: string | null = options.disabledReason ?? null;
  /** True once the server has told us GIFs are off, or if no GIF api was wired. */
  let gifUnavailable = options.gifApi === undefined;
  const controlButtons: HTMLButtonElement[] = [];
  let attachmentPreviewBar: HTMLDivElement | null = null;
  /** Set by mount() when file uploads are wired; backs openFilePicker(). */
  let openPicker: (() => void) | null = null;
  let mentionPopup: MentionAutocompleteComponent | null = null;
  /** Index of the "@" the open popup is completing; -1 when closed. */
  let mentionStart = -1;
  let emojiPopup: EmojiAutocompleteComponent | null = null;
  /** Index of the ":" the open emoji popup is completing; -1 when closed. */
  let emojiStart = -1;

  /** Pending attachment IDs to send with the next message. */
  const pendingAttachments: { id: string; filename: string; readonly previewEl: HTMLDivElement }[] =
    [];
  /** Count of file uploads currently in flight. */
  let pendingUploadCount = 0;
  /** References to picker close functions, set by mount() for destroy() to call. */
  let cleanupPickers: (() => void) | null = null;
  /** Timer IDs for cleanup on destroy. */
  const activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  /**
   * The @token immediately before the caret, or null. The leading boundary
   * mirrors the server's mention rule, so the popup never offers a completion
   * for text ("mail@dom") that a send would not resolve as a mention.
   */
  function activeMentionToken(): { query: string; start: number } | null {
    if (textarea === null) return null;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{0,64})$/u.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    return { query, start: caret - query.length - 1 };
  }

  function closeMentionPopup(): void {
    if (mentionPopup === null) return;
    mentionPopup.destroy();
    mentionPopup = null;
    mentionStart = -1;
  }

  /** Replace the token under the caret with "@token ". */
  function insertMention(token: string): void {
    // The popup can outlive the token it was opened over: a caret move the
    // composer never observed (Ctrl+A, a programmatic selection) leaves
    // mentionStart pointing at an offset the caret no longer follows, and
    // splicing there garbles the draft instead of completing it. Re-derive
    // the token and only commit while it still starts where the popup thinks.
    const active = activeMentionToken();
    if (textarea === null || mentionStart < 0 || active === null || active.start !== mentionStart) {
      closeMentionPopup();
      return;
    }
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, mentionStart);
    const after = textarea.value.slice(caret);
    const inserted = `@${token} `;
    textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    closeMentionPopup();
    autoResize();
    textarea.focus();
  }

  /**
   * The `:token` immediately before the caret, or null. The leading boundary
   * keeps the popup out of ordinary prose: a colon that follows a word ("see
   * this:thing", a "10:30" clock, an "http://" scheme) is punctuation, not the
   * start of a shortcode. A completed `:token:` is skipped too — it is already
   * an emoji, and re-offering completions over it would fight the user.
   */
  function activeEmojiToken(): { query: string; start: number } | null {
    if (textarea === null) return null;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|\s):([A-Za-z0-9_]{0,32})$/.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    if (query.length < MIN_EMOJI_QUERY) return null;
    return { query, start: caret - query.length - 1 };
  }

  function closeEmojiPopup(): void {
    if (emojiPopup === null) return;
    emojiPopup.destroy();
    emojiPopup = null;
    emojiStart = -1;
  }

  /** Replace the `:token` under the caret with the chosen emoji, plus a space. */
  function insertEmoji(insert: string): void {
    // Same staleness guard as insertMention: never splice at an anchor the
    // caret has since moved away from.
    const active = activeEmojiToken();
    if (textarea === null || emojiStart < 0 || active === null || active.start !== emojiStart) {
      closeEmojiPopup();
      return;
    }
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, emojiStart);
    const after = textarea.value.slice(caret);
    const inserted = `${insert} `;
    textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    closeEmojiPopup();
    autoResize();
    textarea.focus();
  }

  /** Open, refilter, or close the emoji popup for whatever is under the caret. */
  function syncEmojiPopup(): void {
    const active = disabledReason === null ? activeEmojiToken() : null;
    if (active === null) {
      closeEmojiPopup();
      return;
    }
    if (emojiPopup === null) {
      emojiPopup = createEmojiAutocomplete({
        onSelect: insertEmoji,
        onClose: closeEmojiPopup,
        // The popup manages combobox/aria-activedescendant state on the
        // textarea for as long as it is open.
        comboboxInput: textarea ?? undefined,
      });
      root?.appendChild(emojiPopup.element);
    }
    emojiStart = active.start;
    if (!emojiPopup.setQuery(active.query)) {
      closeEmojiPopup();
    }
  }

  /** Apply a formatting marker to the current textarea selection. */
  function applyFormatting(marker: string): void {
    if (textarea === null || disabledReason !== null) return;
    const result = wrapWithMarker(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      marker,
    );
    textarea.value = result.value;
    textarea.selectionStart = result.selectionStart;
    textarea.selectionEnd = result.selectionEnd;
    autoResize();
    maybeEmitTyping();
  }

  /** Open, refilter, or close the popup for whatever is under the caret. */
  function syncMentionPopup(): void {
    const active = disabledReason === null ? activeMentionToken() : null;
    if (active === null) {
      closeMentionPopup();
      return;
    }
    if (mentionPopup === null) {
      mentionPopup = createMentionAutocomplete({
        onSelect: insertMention,
        onClose: closeMentionPopup,
        // The popup manages combobox/aria-activedescendant state on the
        // textarea for as long as it is open.
        comboboxInput: textarea ?? undefined,
      });
      root?.appendChild(mentionPopup.element);
    }
    mentionStart = active.start;
    if (!mentionPopup.setQuery(active.query)) {
      closeMentionPopup();
    }
  }

  /**
   * Drive both completion popups from one caret position. Only one can be open:
   * the caret sits in exactly one token, and two stacked popups over the same
   * textarea would race for the arrow keys.
   */
  function syncAutocomplete(): void {
    syncMentionPopup();
    if (mentionPopup !== null) {
      closeEmojiPopup();
      return;
    }
    syncEmojiPopup();
  }

  function showReplyBar(username: string): void {
    if (replyBar === null || replyText === null) return;
    setText(replyText, `Replying to @${username}`);
    replyBar.classList.add("visible");
  }

  function hideReplyBar(): void {
    replyBar?.classList.remove("visible");
  }
  function showEditBar(): void {
    editBar?.classList.add("visible");
  }
  function hideEditBar(): void {
    editBar?.classList.remove("visible");
  }

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

  function showUploadError(message: string): void {
    if (attachmentPreviewBar === null) return;
    const errEl = createElement(
      "div",
      {
        class: "attachment-upload-error",
      },
      message,
    );
    attachmentPreviewBar.appendChild(errEl);
    const t = setTimeout(() => {
      activeTimers.delete(t);
      errEl.remove();
    }, 4000);
    activeTimers.add(t);
  }

  /** Reflect the current disabledReason onto the DOM (textarea + controls). */
  function applyDisabledState(): void {
    if (textarea === null) return;
    const disabled = disabledReason !== null;
    textarea.disabled = disabled;
    textarea.placeholder = disabled ? disabledReason! : `Message #${options.channelName}`;
    for (const btn of controlButtons) {
      if (disabled) {
        btn.setAttribute("disabled", "true");
      } else {
        // Don't re-enable the attach button when uploads aren't wired.
        if (btn.classList.contains("attach-btn") && options.onUploadFile === undefined) continue;
        // Likewise for GIFs when this server has no GIF provider configured.
        if (btn.classList.contains("gif-btn") && gifUnavailable) continue;
        btn.removeAttribute("disabled");
      }
    }
    if (root !== null) {
      root.classList.toggle("composer-disabled", disabled);
    }
  }

  function setDisabled(reason: string | null): void {
    disabledReason = reason;
    applyDisabledState();
  }

  function handleSend(): void {
    if (disabledReason !== null) return;
    if (textarea === null) return;
    const content = textarea.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if (content.length === 0 && !hasAttachments) return;

    // Block send while uploads are still in flight
    if (pendingUploadCount > 0) {
      showUploadError("Please wait for uploads to finish");
      return;
    }

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

  function removePreviewItem(el: HTMLDivElement): void {
    const idx = pendingAttachments.findIndex((a) => a.previewEl === el);
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
  // oxlint-disable-next-line consistent-function-scoping -- co-located with handlePasteFile for readability
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result as string));
      reader.addEventListener("error", () => reject(new Error("Failed to read file")));
      reader.readAsDataURL(file);
    });
  }

  async function handlePasteFile(file: File): Promise<void> {
    if (options.onUploadFile === undefined || attachmentPreviewBar === null) return;

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      showUploadError(`File too large: ${file.name} exceeds 100 MB limit`);
      return;
    }

    // Validate file type — reject files with unknown/empty MIME type
    if (file.type === "" || !ALLOWED_TYPES.some((t) => file.type.startsWith(t))) {
      showUploadError(`${file.name} is not a supported file type`);
      return;
    }

    const tempId = `pending-${++previewCounter}`;
    const isImage = file.type.startsWith("image/");

    attachmentPreviewBar.classList.add("visible");

    const item = createElement("div", { class: "attachment-preview-item uploading" });

    if (isImage) {
      // Read file as data URL for preview (works reliably in WebView2)
      const img = createElement("img", {
        class: "attachment-preview-img",
        alt: file.name,
      });
      item.appendChild(img);
      readFileAsDataUrl(file)
        .then((dataUrl) => {
          if (signal.aborted) return;
          img.src = dataUrl;
        })
        .catch(() => {
          if (signal.aborted) return;
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
    removeBtn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        removePreviewItem(item);
      },
      { signal },
    );
    item.appendChild(removeBtn);

    attachmentPreviewBar.appendChild(item);
    pendingAttachments.push({ id: tempId, filename: file.name, previewEl: item });

    // Upload in background
    pendingUploadCount++;
    try {
      const result = await options.onUploadFile(file);
      // Replace temp ID with real server ID (immutable update)
      const attIdx = pendingAttachments.findIndex((a) => a.id === tempId);
      if (attIdx !== -1) {
        pendingAttachments[attIdx] = {
          ...pendingAttachments[attIdx]!,
          id: result.id,
          filename: result.filename,
        };
        item.classList.remove("uploading");
        spinner.remove();
      }
    } catch (err) {
      // Upload failed — remove preview and show error
      removePreviewItem(item);
      const errMsg = err instanceof Error ? err.message : "Upload failed";
      showUploadError(`Upload failed: ${errMsg}`);
    } finally {
      pendingUploadCount--;
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
    if (textarea !== null) {
      textarea.value = "";
      autoResize();
    }
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
    const attachBtn = createElement(
      "button",
      { class: "input-btn attach-btn", "aria-label": "Attach file" },
      "+",
    );

    // File picker via attach button
    if (options.onUploadFile !== undefined) {
      const fileInput = createElement("input", {
        type: "file",
        style: "display: none;",
        accept: "image/*,video/*,audio/*,.pdf,.txt,.zip",
      });
      fileInput.addEventListener(
        "change",
        () => {
          const file = fileInput.files?.[0];
          if (file != null) {
            void handlePasteFile(file);
          }
          fileInput.value = "";
        },
        { signal },
      );
      attachBtn.addEventListener("click", () => fileInput.click(), { signal });
      openPicker = () => {
        if (disabledReason !== null) return;
        fileInput.click();
      };
      root?.appendChild(fileInput);
    } else {
      attachBtn.setAttribute("disabled", "true");
      attachBtn.title = "File uploads not available";
    }
    textarea = createElement("textarea", {
      class: "msg-textarea",
      placeholder: `Message #${options.channelName}`,
      rows: "1",
      "data-testid": "msg-textarea",
    });
    const emojiBtn = createElement("button", {
      class: "input-btn emoji-btn",
      "aria-label": "Emoji",
    });
    emojiBtn.appendChild(createIcon("smile", 20));
    const gifBtn = createElement(
      "button",
      { class: "input-btn gif-btn", "aria-label": "GIF" },
      "GIF",
    );
    if (gifUnavailable) {
      markGifUnavailable(gifBtn, "GIFs are not enabled on this server");
    }
    const sendBtn = createElement("button", {
      class: "input-btn send-btn",
      "aria-label": "Send message",
      "data-testid": "send-btn",
    });
    sendBtn.appendChild(createIcon("send", 20));
    // Register interactive controls so the disabled state can toggle them.
    controlButtons.length = 0;
    controlButtons.push(sendBtn, emojiBtn, gifBtn);
    if (options.onUploadFile !== undefined) {
      controlButtons.push(attachBtn);
    }

    textarea.addEventListener(
      "input",
      () => {
        autoResize();
        maybeEmitTyping();
        syncAutocomplete();
      },
      { signal },
    );
    textarea.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Whichever popup is open owns navigation keys, so Enter completes the
        // token instead of sending a half-typed message.
        if (mentionPopup?.handleKeydown(e) === true) return;
        if (emojiPopup?.handleKeydown(e) === true) return;

        // Ctrl+B / Ctrl+I / Ctrl+U wrap the selection in markdown markers.
        // The composer owns Ctrl+U while it has focus, so the propagation stop
        // is load-bearing: without it the global upload shortcut would fire on
        // top of the underline.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          const marker = FORMAT_MARKERS[e.key.toLowerCase()];
          if (marker !== undefined) {
            e.preventDefault();
            e.stopPropagation();
            applyFormatting(marker);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
        if (e.key === "Escape") {
          if (state.editing !== null) {
            cancelEdit();
          } else if (state.replyTo !== null) {
            clearReply();
          }
        }
        if (e.key === "ArrowUp" && textarea !== null && textarea.value.length === 0) {
          root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
        }
      },
      { signal },
    );

    // Clipboard paste: detect images/files
    textarea.addEventListener(
      "paste",
      (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (items === undefined) return;
        for (const item of items) {
          if (item.kind !== "file") continue;
          const file = item.getAsFile();
          if (file === null) continue;
          e.preventDefault();
          void handlePasteFile(file);
        }
      },
      { signal },
    );

    // Caret moves that aren't typing (click, arrow/Home/End keys, blur) also
    // decide the popup's fate — without this, completing a mention/emoji
    // after moving the caret away with the keyboard splices at a stale offset.
    textarea.addEventListener("click", syncAutocomplete, { signal });
    textarea.addEventListener(
      "keyup",
      (e: KeyboardEvent) => {
        if (CARET_MOVE_KEYS.has(e.key)) syncAutocomplete();
      },
      { signal },
    );
    textarea.addEventListener(
      "blur",
      () => {
        closeMentionPopup();
        closeEmojiPopup();
      },
      { signal },
    );

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
      if (
        !emojiPicker.element.contains(target) &&
        target !== emojiBtn &&
        !emojiBtn.contains(target)
      ) {
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
        // Read the set at open time, not at mount: an emoji_update while the
        // composer is alive must be in the next picker the user opens.
        customEmoji: listCustomEmoji(),
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
      const t1 = setTimeout(() => {
        activeTimers.delete(t1);
        if (!signal.aborted) {
          document.addEventListener("mousedown", handleClickOutside);
        }
      }, 0);
      activeTimers.add(t1);
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
      const gifApi = options.gifApi;
      if (gifApi === undefined) return;
      // Close emoji picker if open
      if (emojiPicker !== null) {
        closeEmojiPicker();
      }
      if (gifPicker !== null) {
        closeGifPicker();
        return;
      }
      gifPicker = createGifPicker({
        api: gifApi,
        onUnavailable: (reason: string) => {
          gifUnavailable = true;
          markGifUnavailable(gifBtn, reason);
        },
        onSelect: (gifUrl: string) => {
          // Send the GIF directly instead of routing it through the textarea
          // (handleSend's read of textarea.value): that overwrote — and
          // discarded — whatever draft the user had typed, and on slow
          // mode / mid-upload / debounced sends left the raw GIF URL sitting
          // in the composer instead of the draft. Guarded by the same
          // disabledReason/debounce checks as a normal send; an in-progress
          // edit and any typed draft are left untouched.
          if (disabledReason === null) {
            const now = Date.now();
            if (now - lastSendTime >= SEND_DEBOUNCE_MS) {
              lastSendTime = now;
              options.onSend(gifUrl, state.replyTo?.messageId ?? null, []);
              clearReply();
            }
          }
          closeGifPicker();
        },
        onClose: () => {
          closeGifPicker();
        },
      });
      root?.appendChild(gifPicker.element);
      const t2 = setTimeout(() => {
        activeTimers.delete(t2);
        if (!signal.aborted) {
          document.addEventListener("mousedown", handleGifClickOutside);
        }
      }, 0);
      activeTimers.add(t2);
    }

    gifBtn.addEventListener("click", toggleGifPicker, { signal });

    // Store picker cleanup for destroy()
    cleanupPickers = () => {
      closeEmojiPicker();
      closeGifPicker();
      closeMentionPopup();
      closeEmojiPopup();
    };

    appendChildren(inputBox, attachBtn, textarea, emojiBtn, gifBtn, sendBtn);
    appendChildren(root, replyBar, editBar, attachmentPreviewBar, inputBox);
    container.appendChild(root);
    // Apply any initial disabled reason before focusing.
    applyDisabledState();
    if (disabledReason === null) {
      textarea.focus();
    }
  }

  function destroy(): void {
    // Close any open pickers and their document listeners before aborting
    cleanupPickers?.();
    cleanupPickers = null;
    // Clear all pending timers
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
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
    openPicker = null;
  }

  function openFilePicker(): void {
    openPicker?.();
  }

  return {
    mount,
    destroy,
    setReplyTo,
    clearReply,
    startEdit,
    cancelEdit,
    setDisabled,
    openFilePicker,
  };
}
