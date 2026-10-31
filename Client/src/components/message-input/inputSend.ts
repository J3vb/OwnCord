/**
 * Sending from the message input: the send itself, long text sent as a file,
 * and upload errors.
 */
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { replaceEmojiShortcodes } from "../../features/messaging/shortcodes";
import { applyPickedMentions } from "@lib/text/pickedMentions";
import { idMentionsEnabled } from "@lib/net/serverCapabilities";
import { applySlashCommand } from "../../features/messaging/slashCommands";
import { MAX_MESSAGE_LEN } from "../../features/messaging/messageLimits";
import { authStore } from "@stores/auth.store";
import { messagingText } from "../../i18n/messaging";
import {
  SEND_DEBOUNCE_MS,
  FALLBACK_MAX_FILE_SIZE,
  uploadsDisabledByServer,
  refusedExtension,
  MAX_ATTACHMENTS,
  LONG_PASTE_FILENAME,
} from "./inputShared";
import type { InputState, InputApi } from "./inputState";
import type { SentAttachment, QueuedAttachment } from "../MessageInput";

export function createInputSend(st: InputState, api: InputApi) {
  function clearPendingAttachments(): void {
    for (const att of st.pendingAttachments) {
      att.previewEl.remove();
    }
    st.pendingAttachments.length = 0;
    if (st.attachmentPreviewBar !== null) {
      st.attachmentPreviewBar.classList.remove("visible");
    }
  }

  function showUploadError(message: string, action?: { label: string; onClick: () => void }): void {
    if (st.attachmentPreviewBar === null) return;
    // One persistent refusal line: the user needs to read it after the fact,
    // so it is not removed on a timer (A11Y-05). It is cleared by its own
    // dismiss button, the next edit or a successful send (clearUploadError).
    // A line already showing only swaps its text, so a ticking reason (slow
    // mode refreshes every second) never takes focus off the dismiss button.
    const shownText = st.uploadErrorEl?.querySelector(".attachment-upload-error-text");
    if (shownText) {
      shownText.textContent = message;
      st.uploadErrorEl?.querySelector(".attachment-upload-error-action")?.remove();
      if (action) {
        st.uploadErrorEl?.insertBefore(
          createErrorAction(action),
          st.uploadErrorEl.querySelector(".attachment-upload-error-dismiss"),
        );
      }
      return;
    }
    st.uploadErrorEl = createElement("div", {
      class: "attachment-upload-error",
      id: st.uploadErrorId,
    });
    st.uploadErrorEl.appendChild(
      createElement("span", { class: "attachment-upload-error-text" }, message),
    );
    if (action) st.uploadErrorEl.appendChild(createErrorAction(action));
    const dismissBtn = createElement("button", {
      class: "attachment-upload-error-dismiss",
      type: "button",
      "aria-label": messagingText("error.dismiss"),
    });
    dismissBtn.appendChild(createIcon("x", 14));
    dismissBtn.addEventListener(
      "click",
      () => {
        clearUploadError();
        st.textarea?.focus();
      },
      { signal: st.signal },
    );
    st.uploadErrorEl.appendChild(dismissBtn);
    st.textarea?.setAttribute("aria-describedby", st.uploadErrorId);
    // app.css only shows the preview bar via .visible -- without this an
    // error with no attachments already queued renders into a display:none
    // container and is never seen.
    st.attachmentPreviewBar.classList.add("visible");
    st.attachmentPreviewBar.appendChild(st.uploadErrorEl);
  }

  function createErrorAction(action: { label: string; onClick: () => void }): HTMLButtonElement {
    const btn = createElement(
      "button",
      {
        class: "attachment-upload-error-action",
        type: "button",
        "data-testid": "too-long-as-file",
      },
      action.label,
    );
    btn.addEventListener("click", action.onClick, { signal: st.signal });
    return btn;
  }

  /** Clear the composer's refusal line and collapse the preview bar when it
   *  held nothing else. */
  function clearUploadError(): void {
    if (st.uploadErrorEl === null) return;
    st.uploadErrorEl.remove();
    st.uploadErrorEl = null;
    st.textarea?.removeAttribute("aria-describedby");
    if (
      st.attachmentPreviewBar !== null &&
      st.pendingAttachments.length === 0 &&
      st.attachmentPreviewBar.childElementCount === 0
    ) {
      st.attachmentPreviewBar.classList.remove("visible");
    }
  }

  function handleSend(): void {
    // A send gate (slow mode) refuses the send but, unlike `disabledReason`,
    // leaves the draft editable — the user can keep typing and retry.
    const refusal = st.disabledReason ?? st.sendGateReason;
    if (refusal !== null) {
      showUploadError(refusal);
      return;
    }
    if (st.textarea === null) return;
    // Built-in slash commands rewrite the text here, so the attachment and
    // send-while-uploading paths below carry the rewritten message too. A bare
    // /spoiler or /me has nothing to send and leaves the draft as typed.
    const slash = applySlashCommand(st.textarea.value);
    if (slash !== null && "empty" in slash) {
      showUploadError(messagingText("slash.needsText", { name: slash.name }));
      return;
    }
    const typed = replaceEmojiShortcodes(slash === null ? st.textarea.value.trim() : slash.text);
    const content = applyPickedMentions(typed, idMentionsEnabled() ? st.pickedMentions : []);
    const hasAttachments = st.pendingAttachments.length > 0;
    if (content.length === 0 && !hasAttachments) return;

    // The expanded content is what the server counts: a picked `@name` is sent
    // as a longer `<@id>`. The spread counts code points, as the server does;
    // a `.length` check would count UTF-16 units and refuse ~2000 astral emoji
    // the server accepts. Checked before the debounce stamp below so a refused
    // send does not suppress the next one.
    if ([...content].length > MAX_MESSAGE_LEN) {
      showUploadError(
        messagingText("error.tooLong", { max: String(MAX_MESSAGE_LEN) }),
        canAttachLongText(st.textarea.value.trim())
          ? {
              label: messagingText("error.tooLongAsFile", { name: LONG_PASTE_FILENAME }),
              onClick: sendDraftAsFile,
            }
          : undefined,
      );
      return;
    }

    // The age timer can fire late (a sleeping machine, a throttled window), so
    // Send checks the age itself and never posts an id the sweep may have taken.
    const stale = st.pendingAttachments.filter((a) => a.expired === true || api.isStale(a));
    if (stale.length > 0) {
      for (const a of stale) api.refreshStale(a);
      showUploadError(
        messagingText(
          stale.some((a) => a.expired === true)
            ? "error.attachmentExpired"
            : "error.attachmentRefreshing",
        ),
      );
      return;
    }

    // Debounce to prevent double-click duplicate sends
    const now = Date.now();
    if (now - st.lastSendTime < SEND_DEBOUNCE_MS) return;
    st.lastSendTime = now;

    // Only include attachments that have finished uploading (have a real server
    // ID); a chip refreshing a stale id is still uploading, its old id unsent.
    const files = st.pendingAttachments.flatMap((a): SentAttachment[] =>
      a.upload !== undefined || a.id.startsWith("pending-")
        ? []
        : [{ id: a.id, filename: a.filename, ...(a.file === undefined ? {} : { file: a.file }) }],
    );
    // An upload still running does not hold the message back: the host queues
    // it, takes the handles over and posts once they all land (3A-9).
    const queued = st.pendingAttachments.some((a) => a.upload !== undefined)
      ? st.pendingAttachments.map((a): QueuedAttachment => {
          if (a.upload !== undefined) a.upload.onProgress = null;
          return {
            filename: a.filename,
            ...(a.file === undefined ? {} : { file: a.file }),
            ...(a.upload === undefined
              ? { id: a.id, ...(a.uploadedAt === undefined ? {} : { uploadedAt: a.uploadedAt }) }
              : { upload: a.upload }),
          };
        })
      : undefined;
    st.options.onSend(
      content,
      st.state.replyTo?.messageId ?? null,
      files.map((f) => f.id),
      files,
      api.replyPing(),
      ...(queued === undefined ? [] : [queued]),
    );
    api.clearReply();
    clearPendingAttachments();

    st.textarea.value = "";
    st.pickedMentions = [];
    api.closeSlashPopup();
    api.autoResize();
    st.textarea.focus();
    clearUploadError();
  }

  /** True when `text` could go up as the long-text file: uploads are wired and
   *  allowed, the name and size pass the server's policy, and there is room
   *  in the queue. */
  function canAttachLongText(text: string): boolean {
    if (st.options.onUploadFile === undefined) return false;
    if (st.disabledReason !== null || uploadsDisabledByServer()) return false;
    const maxBytes = authStore.getState().uploadPolicy?.max_upload_bytes ?? FALLBACK_MAX_FILE_SIZE;
    return (
      refusedExtension(LONG_PASTE_FILENAME) === null &&
      new Blob([text]).size <= maxBytes &&
      st.pendingAttachments.length < MAX_ATTACHMENTS
    );
  }

  /** Moves a draft that is too long to send into a pending message.txt. The
   *  text is read now, not when Send was refused: formatting shortcuts change
   *  it without an input event that would clear the refusal. */
  function sendDraftAsFile(): void {
    if (st.textarea === null) return;
    const draft = st.textarea.value.trim();
    if (!canAttachLongText(draft)) return;
    const file = new File([draft], LONG_PASTE_FILENAME, { type: "text/plain" });
    st.textarea.value = "";
    st.pickedMentions = [];
    api.autoResize();
    clearUploadError();
    st.textarea.focus();
    void api.handlePasteFile(file, draft);
  }

  /** A paste that would take the message past the limit goes up as
   *  message.txt, as Discord does, instead of a draft that can never send.
   *  When the file could not be attached the paste stays plain text. */
  function pasteLongTextAsFile(e: ClipboardEvent): void {
    if (st.textarea === null) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;
    const { value, selectionStart, selectionEnd } = st.textarea;
    const after = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    if ([...after.trim()].length <= MAX_MESSAGE_LEN) return;
    if (!canAttachLongText(text)) return;
    const file = new File([text], LONG_PASTE_FILENAME, { type: "text/plain" });
    e.preventDefault();
    void api.handlePasteFile(file);
  }

  return {
    clearPendingAttachments,
    showUploadError,
    createErrorAction,
    clearUploadError,
    handleSend,
    canAttachLongText,
    sendDraftAsFile,
    pasteLongTextAsFile,
  };
}
