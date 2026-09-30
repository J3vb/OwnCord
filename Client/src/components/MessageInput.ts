/**
 * MessageInput component — textarea with send, reply bar, and edit mode.
 * Step 5.42 of the Tauri v2 migration.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
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
import { authStore } from "@stores/auth.store";
import { messagingText } from "../i18n/messaging";
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
  readonly onUploadFile?: (
    file: File,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ) => Promise<{ id: string; url: string; filename: string }>;
  readonly onTyping: () => void;
  readonly onEditMessage: (messageId: number, content: string) => void;
  /** Initial disabled reason (e.g. read-only / no-permission / offline). */
  readonly disabledReason?: string | null;
}

/** A channel's unsent composer state, captured before a channel switch and
 *  restored when the user returns (UX-1). Uploads settled before the switch
 *  keep their server id; an upload still in flight is not carried (it is
 *  cancelled on unmount, per SRV-05). */
export interface ComposerDraft {
  readonly content: string;
  readonly replyTo: { readonly messageId: number; readonly username: string } | null;
  readonly attachments: readonly {
    readonly id: string;
    readonly filename: string;
    /** Date.now() when the upload settled; ages the chip on restore. */
    readonly uploadedAt: number;
  }[];
}

export type MessageInputComponent = MountableComponent & {
  setReplyTo(messageId: number, username: string): void;
  clearReply(): void;
  startEdit(messageId: number, content: string): void;
  cancelEdit(): void;
  /** Capture the current unsent state so a channel switch can carry it. */
  getDraft(): ComposerDraft;
  /** Restore a previously captured draft into this (fresh) composer. */
  restoreDraft(draft: ComposerDraft): void;
  /** True when the composer holds no text, reply, edit or attachment. */
  isIdle(): boolean;
  /**
   * Disable the composer with a visible reason (permission / connection), or
   * pass null to re-enable. Permission is expressed as affordance: a send that
   * the server would refuse is prevented here, not attempted and rejected.
   */
  setDisabled(reason: string | null): void;
  /**
   * Gate sending only, leaving the composer editable (slow mode). The reason
   * shows on a refused send and greys the send control; the user can keep
   * editing the draft. Pass null to lift.
   */
  setSendGate(reason: string | null): void;
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
    // The characters immediately outside the selection match this marker,
    // but matching alone doesn't prove they *are* this marker rather than
    // the edge of a longer run of the same repeated character — e.g. the
    // single "*" bordering a double-clicked word inside "**bold**" matches
    // the italic marker "*", but it's really one half of a "**" bold pair.
    // Compare the full contiguous run of the marker's character against
    // exactly one marker-width: a run that's a whole marker-width *longer*
    // means the true neighbour is a bigger marker, so unwrapping here would
    // tear it apart. Fall through to wrapping (adding this marker as an
    // extra layer) instead.
    const markerChar = marker[0];
    const runLength = (index: number, step: -1 | 1): number => {
      let i = index;
      let count = 0;
      while (value[i] === markerChar) {
        count++;
        i += step;
      }
      return count;
    };
    const leftRun = runLength(start - 1, -1);
    const rightRun = runLength(end, 1);
    const leftIsLongerMarker = leftRun - len === len;
    const rightIsLongerMarker = rightRun - len === len;
    if (!leftIsLongerMarker && !rightIsLongerMarker) {
      return {
        value: value.slice(0, start - len) + selected + value.slice(end + len),
        selectionStart: start - len,
        selectionEnd: start - len + selected.length,
      };
    }
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
// The server's per-file cap arrives on auth_ok (upload_policy); an older
// server, or one with no per-file cap, falls back to its 100 MiB request cap.
// The server stays authoritative: this only refuses a doomed upload early.
const FALLBACK_MAX_FILE_SIZE = 100 * 1024 * 1024;
// Server/ws/command.go rejects the whole chat_send frame (as a generic parse
// error, not an attachment-specific one) once len(Attachments) > 10 -- cap
// the queue client-side so we never upload an attachment doomed to be
// orphaned by a send that can never succeed.
const MAX_ATTACHMENTS = 10;
// Server/service/message.go's maxMessageLen refuses content past 4000 code
// points (utf8.RuneCountInString). Mirror it here so an over-long send fails
// visibly instead of producing an optimistic row whose retry fails identically.
// Counted in code points, not UTF-16 units -- see the guard in handleSend.
const MAX_MESSAGE_LEN = 4000;
// The server's maintenance sweep deletes unlinked attachments about an hour
// after upload (Server/internal/app/maintenance.go), and a send silently skips
// an id it no longer knows. A restored draft drops chips past this age, with
// a margin under the sweep, rather than posting the message without the file.
const DRAFT_ATTACHMENT_TTL_MS = 50 * 60 * 1000;
/** Makes each composer's refusal-line id unique for aria-describedby. */
let nextComposerId = 0;

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
  "Home", // i18n-exempt: KeyboardEvent.key value, a wire identifier, never displayed
  "End", // i18n-exempt: KeyboardEvent.key value, a wire identifier, never displayed
  "PageUp",
  "PageDown",
]);

/** Disable the GIF button and say why, instead of silently doing nothing. */
function markGifUnavailable(gifBtn: HTMLButtonElement, reason: string): void {
  gifBtn.setAttribute("disabled", "true");
  gifBtn.title = reason;
  gifBtn.setAttribute("aria-label", messagingText("gif.ariaWithReason", { reason }));
}

/** File-icon + filename label for a non-image attachment chip. */
function appendFileLabel(item: HTMLDivElement, filename: string): void {
  const icon = createElement("div", { class: "attachment-preview-file" });
  icon.appendChild(createIcon("file-text", 16));
  const nameEl = createElement("span", { class: "attachment-preview-name" }, filename);
  appendChildren(item, icon, nameEl);
}

export function createMessageInput(options: MessageInputOptions): MessageInputComponent {
  const disposable = new Disposable();
  const signal = disposable.signal;
  let root: HTMLDivElement | null = null;
  let state = {
    replyTo: null as { messageId: number; username: string } | null,
    editing: null as { messageId: number } | null,
  };
  /** The ordinary draft (text + reply) displaced by an edit, so cancelling or
   *  saving the edit gives the user back what they were typing (P1-08). Staged
   *  attachments are untouched by an edit and read live from the composer. */
  let preEditDraft: {
    text: string;
    replyTo: { messageId: number; username: string } | null;
  } | null = null;
  let lastTypingTime = 0;
  let lastSendTime = 0;

  let textarea: HTMLTextAreaElement | null = null;
  let replyBar: HTMLDivElement | null = null;
  let replyText: HTMLSpanElement | null = null;
  let editBar: HTMLDivElement | null = null;
  let disabledReason: string | null = options.disabledReason ?? null;
  /** Slow-mode-style gate: refuses the send without freezing the composer. */
  let sendGateReason: string | null = null;
  /** True once the server has told us GIFs are off, or if no GIF api was wired. */
  let gifUnavailable = options.gifApi === undefined;
  const controlButtons: HTMLButtonElement[] = [];
  let attachmentPreviewBar: HTMLDivElement | null = null;
  /** The composer's single refusal line. It stays until the user edits or
   *  sends rather than vanishing after a few seconds (A11Y-05), so it is one
   *  reused node, not a fresh one per call. */
  let uploadErrorEl: HTMLDivElement | null = null;
  const uploadErrorId = `composer-refusal-${++nextComposerId}`;
  /** Set by mount() when file uploads are wired; backs openFilePicker(). */
  let openPicker: (() => void) | null = null;
  let mentionPopup: MentionAutocompleteComponent | null = null;
  /** Index of the "@" the open popup is completing; -1 when closed. */
  let mentionStart = -1;
  let emojiPopup: EmojiAutocompleteComponent | null = null;
  /** Index of the ":" the open emoji popup is completing; -1 when closed. */
  let emojiStart = -1;

  /** Pending attachment IDs to send with the next message. `owner` is set
   *  exactly while the upload is in flight, so it alone is what blocks Send:
   *  destroying it cancels that upload when the user removes the preview, and
   *  it is detached once the upload succeeds. A `Disposable` rather than a raw
   *  AbortController keeps the upload token in the lifecycle primitives,
   *  matching MessageList's per-row owner. */
  const pendingAttachments: {
    id: string;
    filename: string;
    readonly previewEl: HTMLDivElement;
    owner?: Disposable;
    uploadedAt?: number;
  }[] = [];
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
    setText(replyText, messagingText("reply.replyingTo", { username }));
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
    // One persistent refusal line: the user needs to read it after the fact,
    // so it is not removed on a timer (A11Y-05). It is cleared by the next
    // edit or successful send (clearUploadError).
    clearUploadError();
    uploadErrorEl = createElement(
      "div",
      {
        class: "attachment-upload-error",
        id: uploadErrorId,
      },
      message,
    );
    textarea?.setAttribute("aria-describedby", uploadErrorId);
    // app.css only shows the preview bar via .visible -- without this an
    // error with no attachments already queued renders into a display:none
    // container and is never seen.
    attachmentPreviewBar.classList.add("visible");
    attachmentPreviewBar.appendChild(uploadErrorEl);
  }

  /** Clear the composer's refusal line and collapse the preview bar when it
   *  held nothing else. */
  function clearUploadError(): void {
    if (uploadErrorEl === null) return;
    uploadErrorEl.remove();
    uploadErrorEl = null;
    textarea?.removeAttribute("aria-describedby");
    if (
      attachmentPreviewBar !== null &&
      pendingAttachments.length === 0 &&
      attachmentPreviewBar.childElementCount === 0
    ) {
      attachmentPreviewBar.classList.remove("visible");
    }
  }

  /** Reflect the current disabledReason onto the DOM (textarea + controls). */
  function applyDisabledState(): void {
    if (textarea === null) return;
    const disabled = disabledReason !== null;
    // UX-1 / DESIGN_SYSTEM "Disabled": a gated composer uses aria-disabled +
    // readOnly rather than the `disabled` attribute, because disabling a
    // focused element drops focus to <body> and loses the caret mid-sentence.
    // Send is refused in handleSend() with the reason; the buttons stay
    // `disabled` (they are not focus targets the user is typing into).
    textarea.readOnly = disabled;
    textarea.setAttribute("aria-disabled", String(disabled));
    textarea.placeholder = disabled
      ? disabledReason!
      : messagingText("composer.placeholder", { channel: options.channelName });
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
    // A slow-mode send gate does not freeze the composer, but the send control
    // must read as unavailable, and the reason becomes its title.
    const sendBtn = controlButtons[0];
    if (sendBtn !== undefined && !disabled) {
      const gated = sendGateReason !== null;
      sendBtn.classList.toggle("send-gated", gated);
      sendBtn.title = gated ? sendGateReason! : "";
    }
  }

  function setDisabled(reason: string | null): void {
    if (uploadErrorEl?.textContent === disabledReason) {
      if (reason === null) clearUploadError();
      else showUploadError(reason);
    }
    disabledReason = reason;
    applyDisabledState();
  }

  function setSendGate(reason: string | null): void {
    if (uploadErrorEl?.textContent === sendGateReason) {
      if (reason === null) clearUploadError();
      else showUploadError(reason);
    }
    sendGateReason = reason;
    applyDisabledState();
  }

  function handleSend(): void {
    // A send gate (slow mode) refuses the send but, unlike `disabledReason`,
    // leaves the draft editable — the user can keep typing and retry.
    const refusal = disabledReason ?? sendGateReason;
    if (refusal !== null) {
      showUploadError(refusal);
      return;
    }
    if (textarea === null) return;
    const content = textarea.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    // Edits are text-only, so a queued attachment must not unlock submitting
    // an edit whose text was cleared -- that would tear down edit mode for a
    // send the host refuses anyway.
    if (content.length === 0 && (state.editing !== null || !hasAttachments)) return;

    // The spread counts code points, which is what the server counts. A
    // `.length` check here would count UTF-16 units and refuse ~2000 astral
    // emoji the server accepts. Checked before the debounce stamp below so a
    // refused send does not suppress the next one.
    if ([...content].length > MAX_MESSAGE_LEN) {
      showUploadError(messagingText("error.tooLong", { max: String(MAX_MESSAGE_LEN) }));
      return;
    }

    // Block send while uploads are still in flight
    if (pendingAttachments.some((a) => a.owner)) {
      showUploadError(messagingText("error.uploadsPending"));
      return;
    }

    // Debounce to prevent double-click duplicate sends
    const now = Date.now();
    if (now - lastSendTime < SEND_DEBOUNCE_MS) return;
    lastSendTime = now;

    if (state.editing !== null) {
      options.onEditMessage(state.editing.messageId, content);
      // P1-08: sending the edit returns the composer to the ordinary draft the
      // edit displaced, instead of clearing everything.
      restorePreEditDraft();
      clearUploadError();
      textarea.focus();
      return;
    }

    // Only include attachments that have finished uploading (have a real server ID)
    const attachmentIds = pendingAttachments
      .filter((a) => !a.id.startsWith("pending-"))
      .map((a) => a.id);
    options.onSend(content, state.replyTo?.messageId ?? null, attachmentIds);
    clearReply();
    clearPendingAttachments();

    textarea.value = "";
    autoResize();
    textarea.focus();
    clearUploadError();
  }

  /** Unique counter for preview items (before upload completes and we have a server ID). */
  let previewCounter = 0;

  function removePreviewItem(el: HTMLDivElement): void {
    const idx = pendingAttachments.findIndex((a) => a.previewEl === el);
    const att = idx !== -1 ? pendingAttachments[idx] : undefined;
    if (att !== undefined) {
      // SRV-05: removing an in-flight attachment cancels its upload and frees
      // Send immediately, instead of leaving a doomed request running and the
      // composer blocked on it until the request settles.
      att.owner?.destroy();
      const img = att.previewEl.querySelector("img");
      if (img !== null && img.src.startsWith("blob:")) {
        URL.revokeObjectURL(img.src);
      }
      att.previewEl.remove();
      pendingAttachments.splice(idx, 1);
      if (pendingAttachments.length === 0 && attachmentPreviewBar?.childElementCount === 0) {
        attachmentPreviewBar.classList.remove("visible");
      }
    }
  }

  /** Read a File as a data: URL (more reliable than createObjectURL in WebView2). */
  // oxlint-disable-next-line consistent-function-scoping -- co-located with handlePasteFile for readability
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result as string));
      // i18n-exempt: internal read failure, surfaced only as the caller's own upload toast
      reader.addEventListener("error", () => reject(new Error("Failed to read file")));
      reader.readAsDataURL(file);
    });
  }

  /** The chip's × button; removing the chip cancels its upload, if any. */
  function appendRemoveButton(item: HTMLDivElement, filename: string): void {
    const removeBtn = createElement("button", {
      class: "attachment-preview-remove",
      "data-testid": "attachment-remove",
      "aria-label": messagingText("attach.remove", { filename }),
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
  }

  async function handlePasteFile(file: File): Promise<void> {
    if (options.onUploadFile === undefined || attachmentPreviewBar === null) return;
    if (disabledReason !== null) return;

    // Attachments queued during an edit are neither sent (the edit branch
    // never reads pendingAttachments) nor cleared -- they'd silently ride
    // along with the next ordinary message. Refuse at the single entry point.
    if (state.editing !== null) {
      showUploadError(messagingText("error.attachWhileEditing"));
      return;
    }

    // Any file type may be attached: the server sniffs the content, refuses
    // its blocked types and serves unsafe ones as downloads.
    const maxBytes = authStore.getState().uploadPolicy?.max_upload_bytes || FALLBACK_MAX_FILE_SIZE;
    if (file.size > maxBytes) {
      showUploadError(
        messagingText("error.fileTooLarge", {
          filename: file.name,
          limit: String(Math.floor(maxBytes / (1024 * 1024))),
        }),
      );
      return;
    }

    // Cap the queue at the server's hard limit. Refusing here -- before the
    // upload starts -- keeps the composer's state and the eventual send in
    // sync with what the server will actually accept.
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      showUploadError(messagingText("error.tooManyAttachments", { max: String(MAX_ATTACHMENTS) }));
      return;
    }

    const tempId = `pending-${++previewCounter}`;
    const isImage = file.type.startsWith("image/");

    // A valid attachment is the user acting on any earlier refusal.
    clearUploadError();
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
      appendFileLabel(item, file.name);
    }

    // A native progress bar on the chip: indeterminate (no value) while the
    // transport reports nothing, determinate from its first tick.
    const progressBar = createElement("progress", { "aria-label": file.name });
    item.appendChild(progressBar);

    appendRemoveButton(item, file.name);
    attachmentPreviewBar.appendChild(item);
    const uploadOwner = new Disposable();
    const pending: (typeof pendingAttachments)[number] = {
      id: tempId,
      filename: file.name,
      previewEl: item,
      owner: uploadOwner,
    };
    pendingAttachments.push(pending);

    // Upload in background
    try {
      // A late tick after the preview is removed writes a detached node only.
      const result = await options.onUploadFile(
        file,
        uploadOwner.signal,
        (fraction) => (progressBar.value = fraction),
      );
      // Replace temp ID with real server ID, unless the preview was removed
      if (!uploadOwner.signal.aborted) {
        pending.id = result.id;
        pending.filename = result.filename;
        pending.owner = undefined;
        pending.uploadedAt = Date.now();
        item.classList.remove("uploading");
        progressBar.remove();
      }
    } catch (err) {
      // A user-cancelled upload (removed preview) is not a failure: the
      // preview is already gone and there is nothing to report.
      if (uploadOwner.signal.aborted) return;
      // Upload failed — remove preview and show error
      removePreviewItem(item);
      const errMsg = errorText(err, messagingText("error.uploadFailed"));
      showUploadError(messagingText("error.uploadFailedDetail", { detail: errMsg }));
    }
  }

  function setReplyTo(messageId: number, username: string): void {
    // Leaving edit mode for reply mode discards the edit and gives back the
    // ordinary draft the edit displaced. Without this the stale edit text
    // survives into reply mode and Enter reposts it as a duplicate.
    if (state.editing !== null) cancelEdit();
    state = { replyTo: { messageId, username }, editing: null };
    showReplyBar(username);
    textarea?.focus();
  }

  function clearReply(): void {
    state = { ...state, replyTo: null };
    hideReplyBar();
  }

  function startEdit(messageId: number, content: string): void {
    // P1-08: stash what the user was typing (text + reply) before the edit
    // takes over the composer, so cancelling or saving gives it back. Staged
    // attachments are left in place and read live, not part of the stash.
    if (preEditDraft === null) {
      preEditDraft = { text: textarea?.value ?? "", replyTo: state.replyTo };
    }
    if (state.replyTo !== null) hideReplyBar();
    state = { replyTo: null, editing: { messageId } };
    showEditBar();
    if (textarea !== null) {
      textarea.value = content;
      autoResize();
      textarea.focus();
    }
  }

  /** Return the composer to the ordinary draft an edit displaced. Falls back to
   *  an empty composer when an edit was opened without one. */
  function restorePreEditDraft(): void {
    const stashed = preEditDraft ?? { text: "", replyTo: null };
    preEditDraft = null;
    state = { replyTo: stashed.replyTo, editing: null };
    hideEditBar();
    if (textarea !== null) {
      textarea.value = stashed.text;
      autoResize();
    }
    if (stashed.replyTo !== null) showReplyBar(stashed.replyTo.username);
    else hideReplyBar();
  }

  function cancelEdit(): void {
    restorePreEditDraft();
  }

  function isIdle(): boolean {
    return (
      (textarea?.value ?? "") === "" &&
      state.replyTo === null &&
      state.editing === null &&
      pendingAttachments.length === 0
    );
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "message-input-wrap", "data-testid": "message-input" });

    replyBar = createElement("div", { class: "reply-bar" });
    const replyInner = createElement("div", { class: "reply-bar-inner" });
    replyText = createElement("strong", {});
    replyInner.appendChild(replyText);
    const replyClose = createElement("button", {
      class: "reply-close",
      "aria-label": messagingText("reply.cancel"),
    });
    replyClose.appendChild(createIcon("x", 14));
    replyClose.addEventListener("click", clearReply, { signal });
    replyInner.appendChild(replyClose);
    replyBar.appendChild(replyInner);

    editBar = createElement("div", { class: "reply-bar" });
    const editInner = createElement("div", { class: "reply-bar-inner" });
    const editText = createElement("strong", {}, messagingText("edit.editing"));
    editInner.appendChild(editText);
    const editClose = createElement("button", {
      class: "reply-close",
      "aria-label": messagingText("edit.cancel"),
    });
    editClose.appendChild(createIcon("x", 14));
    editClose.addEventListener("click", () => cancelEdit(), { signal });
    editInner.appendChild(editClose);
    editBar.appendChild(editInner);

    attachmentPreviewBar = createElement("div", { class: "attachment-preview-bar" });

    const inputBox = createElement("div", { class: "message-input-box" });
    const attachBtn = createElement(
      "button",
      { class: "input-btn attach-btn", "aria-label": messagingText("attach.label") },
      "+",
    );

    // File picker via attach button
    if (options.onUploadFile !== undefined) {
      const fileInput = createElement("input", {
        type: "file",
        style: "display: none;",
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
      attachBtn.title = messagingText("attach.unavailable");
    }
    textarea = createElement("textarea", {
      class: "msg-textarea",
      placeholder: messagingText("composer.placeholder", { channel: options.channelName }),
      rows: "1",
      "data-testid": "msg-textarea",
    });
    const emojiBtn = createElement("button", {
      class: "input-btn emoji-btn",
      "aria-label": messagingText("emoji.label"),
    });
    emojiBtn.appendChild(createIcon("smile", 20));
    const gifBtn = createElement(
      "button",
      { class: "input-btn gif-btn", "aria-label": messagingText("gif.button") },
      messagingText("gif.button"),
    );
    if (gifUnavailable) {
      markGifUnavailable(gifBtn, messagingText("gif.disabled"));
    }
    const sendBtn = createElement("button", {
      class: "input-btn send-btn",
      "aria-label": messagingText("send.label"),
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
        // An edit is the user acting on the refusal, so the line goes away.
        clearUploadError();
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
          // A CJK IME commits the current candidate on Enter, firing keydown
          // with isComposing true (or the legacy keyCode 229). Sending here
          // would ship the raw composition text instead of the committed word.
          if (e.isComposing || e.keyCode === 229) return;
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
        if (
          e.key === "ArrowUp" &&
          disabledReason === null &&
          textarea !== null &&
          textarea.value.length === 0
        ) {
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
    // One outside-click owner per open picker, destroyed when that picker closes.
    let emojiDismiss: Disposable | null = null;
    let gifDismiss: Disposable | null = null;

    function closeEmojiPicker(): void {
      if (emojiPicker !== null) {
        emojiPicker.element.remove();
        emojiPicker.destroy();
        emojiPicker = null;
        emojiDismiss?.destroy();
        emojiDismiss = null;
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
      const dismiss = new Disposable();
      emojiDismiss = dismiss;
      // Defer so this click doesn't immediately close it
      const t1 = setTimeout(() => {
        activeTimers.delete(t1);
        if (!signal.aborted) {
          document.addEventListener("mousedown", handleClickOutside, { signal: dismiss.signal });
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
        gifDismiss?.destroy();
        gifDismiss = null;
      }
    }

    function handleGifClickOutside(e: MouseEvent): void {
      if (gifPicker === null) return;
      const target = e.target as Node;
      if ((target as Element).closest?.(".modal-overlay")) return;
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
          // refusal/debounce checks as a normal send; an in-progress
          // edit and any typed draft are left untouched.
          const refusal = disabledReason ?? sendGateReason;
          if (refusal !== null) {
            showUploadError(refusal);
          } else {
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
      const dismiss = new Disposable();
      gifDismiss = dismiss;
      const t2 = setTimeout(() => {
        activeTimers.delete(t2);
        if (!signal.aborted) {
          document.addEventListener("mousedown", handleGifClickOutside, { signal: dismiss.signal });
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
    // SRV-05: a channel switch or unmount must not leave an upload running
    // against a composer that no longer exists.
    for (const att of pendingAttachments) att.owner?.destroy();
    disposable.destroy();
    // Image previews now use data: URLs (via readFileAsDataUrl) which don't
    // require revocation — just clear the array and let GC reclaim them.
    pendingAttachments.length = 0;
    root?.remove();
    root = null;
    textarea = null;
    replyBar = null;
    replyText = null;
    editBar = null;
    preEditDraft = null;
    attachmentPreviewBar = null;
    uploadErrorEl = null;
    openPicker = null;
  }

  function openFilePicker(): void {
    openPicker?.();
  }

  /** Capture the unsent state for a channel switch. Only settled attachments
   *  carry their server id; an in-flight upload is not carried (SRV-05 aborts
   *  it on unmount). Mid-edit this is the draft the edit displaced: the edit
   *  text itself is never stashed, since restored outside edit mode it would
   *  send as a duplicate new message. */
  function getDraft(): ComposerDraft {
    const stashed = preEditDraft ?? { text: textarea?.value ?? "", replyTo: state.replyTo };
    return {
      content: stashed.text,
      replyTo: stashed.replyTo,
      attachments: pendingAttachments.flatMap((a) =>
        a.uploadedAt === undefined
          ? []
          : [{ id: a.id, filename: a.filename, uploadedAt: a.uploadedAt }],
      ),
    };
  }

  /** Restore a captured draft into this (fresh) composer: text, reply bar and
   *  a ready chip (no spinner) per still-live upload, so its id sends without
   *  re-uploading. */
  function restoreDraft(draft: ComposerDraft): void {
    if (textarea !== null) {
      textarea.value = draft.content;
      autoResize();
    }
    if (draft.replyTo !== null) setReplyTo(draft.replyTo.messageId, draft.replyTo.username);
    const now = Date.now();
    const live = draft.attachments.filter((a) => now - a.uploadedAt < DRAFT_ATTACHMENT_TTL_MS);
    for (const att of live) {
      if (attachmentPreviewBar === null) break;
      const item = createElement("div", { class: "attachment-preview-item" });
      appendFileLabel(item, att.filename);
      appendRemoveButton(item, att.filename);
      attachmentPreviewBar.classList.add("visible");
      attachmentPreviewBar.appendChild(item);
      pendingAttachments.push({ ...att, previewEl: item });
    }
    if (live.length < draft.attachments.length) {
      showUploadError(messagingText("error.draftAttachmentExpired"));
    }
  }

  return {
    mount,
    destroy,
    setReplyTo,
    clearReply,
    startEdit,
    cancelEdit,
    isIdle,
    setDisabled,
    setSendGate,
    openFilePicker,
    getDraft,
    restoreDraft,
  };
}
