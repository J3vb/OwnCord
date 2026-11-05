/**
 * The composer textarea's own event wiring: typing, the key table, paste, file
 * drops and the caret moves that decide an autocomplete popup's fate.
 */
import { isImeCommit } from "@lib/text/ime";
import { isAndroidApp } from "../../features/voice/native/platform";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { FORMAT_MARKERS } from "../../features/messaging/markdownMarkers";
import { DROP_SLOTS, CARET_MOVE_KEYS } from "./inputShared";
import type { InputState, InputApi } from "./inputState";

/** Whichever popup is open owns navigation keys, so Enter completes the
 *  token instead of sending a half-typed message. */
function popupOwnsKey(st: InputState, e: KeyboardEvent): boolean {
  return (
    st.slashPopup?.handleKeydown(e) === true ||
    st.mentionPopup?.handleKeydown(e) === true ||
    st.channelPopup?.handleKeydown(e) === true ||
    st.emojiPopup?.handleKeydown(e) === true
  );
}

/** Ctrl+B / Ctrl+I / Ctrl+U wrap the selection in markdown markers. The
 *  composer owns Ctrl+U while it has focus, so the propagation stop is
 *  load-bearing: without it the global upload shortcut would fire on top of
 *  the underline. Returns whether the key was a formatting shortcut. */
function applyFormatShortcut(api: InputApi, e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  const marker = FORMAT_MARKERS[e.key.toLowerCase()];
  if (marker === undefined) return false;
  e.preventDefault();
  e.stopPropagation();
  api.applyFormatting(marker);
  return true;
}

/** Enter sends; returns whether the key was an unshifted Enter, handled or not. */
function sendOnEnter(api: InputApi, e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  // A CJK IME commits the current candidate on Enter, firing keydown
  // with isComposing true (or the legacy keyCode 229). Sending here
  // would ship the raw composition text instead of the committed word.
  if (isImeCommit(e)) return true;
  // On the Android app Enter adds a new line, and the send button sends.
  if (isAndroidApp()) return true;
  e.preventDefault();
  api.handleSend();
  return true;
}

/** An Escape that cancels something is used up: the app-wide Escape (mark the
 *  channel read) leaves a prevented key alone. */
function cancelReplyOnEscape(st: InputState, api: InputApi, e: KeyboardEvent): void {
  if (e.key !== "Escape" || isImeCommit(e) || st.state.replyTo === null) return;
  e.preventDefault();
  api.clearReply();
}

function editLastOnArrowUp(st: InputState, e: KeyboardEvent): void {
  if (e.key !== "ArrowUp") return;
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  if (st.disabledReason !== null || st.textarea === null || st.textarea.value.length !== 0) return;
  // The browser's own ArrowUp would move the caret in the (empty)
  // composer as the inline editor takes focus.
  e.preventDefault();
  st.root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
}

function handleKeydown(st: InputState, api: InputApi, e: KeyboardEvent): void {
  if (popupOwnsKey(st, e)) return;
  if (applyFormatShortcut(api, e)) return;
  if (sendOnEnter(api, e)) return;
  cancelReplyOnEscape(st, api, e);
  editLastOnArrowUp(st, e);
}

function handlePaste(api: InputApi, e: ClipboardEvent): void {
  const items = e.clipboardData?.items;
  if (items === undefined) return;
  let pastedFile = false;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    e.preventDefault();
    pastedFile = true;
    void api.handlePasteFile(file);
  }
  if (pastedFile || api.pasteNativeFiles(e)) return;
  api.pasteLongTextAsFile(e);
}

/** Typing, the key table and paste. */
export function wireTextareaInput(
  st: InputState,
  api: InputApi,
  textarea: HTMLTextAreaElement,
): void {
  textarea.addEventListener(
    "input",
    () => {
      api.autoResizeOnInput();
      api.maybeEmitTyping();
      // A cleared draft forgets what was picked into it.
      if (st.textarea?.value === "") st.pickedMentions = [];
      api.syncAutocomplete();
      // An edit is the user acting on the refusal, so the line goes away.
      api.clearUploadError();
    },
    { signal: st.signal },
  );
  textarea.addEventListener("keydown", (e: KeyboardEvent) => handleKeydown(st, api, e), {
    signal: st.signal,
  });
  // Clipboard paste: detect images/files
  textarea.addEventListener("paste", (e: ClipboardEvent) => handlePaste(api, e), {
    signal: st.signal,
  });
}

/** Files dragged in from the OS: accepted over the channel view only, and
 *  never while an overlay covers it. Other drops are left to the app-wide
 *  fileDropGuard, which cancels them without uploading. */
export function wireFileDrop(st: InputState, api: InputApi, container: Element): void {
  document.addEventListener(
    "drop",
    (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt === null || !dt.types.includes("Files")) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(st.options.dropZone ?? DROP_SLOTS) === null) return;
      if (dialogOpen()) return;
      e.preventDefault();
      for (const file of dt.files) void api.handlePasteFile(file);
    },
    { signal: st.signal },
  );
  api.wireDropOverlay(container);
}

/** Caret moves that aren't typing (click, arrow/Home/End keys, blur) also
 *  decide the popup's fate — without this, completing a mention/emoji
 *  after moving the caret away with the keyboard splices at a stale offset. */
export function wireCaretEvents(
  st: InputState,
  api: InputApi,
  textarea: HTMLTextAreaElement,
): void {
  textarea.addEventListener("click", api.syncAutocomplete, { signal: st.signal });
  textarea.addEventListener(
    "keyup",
    (e: KeyboardEvent) => {
      if (CARET_MOVE_KEYS.has(e.key)) api.syncAutocomplete();
    },
    { signal: st.signal },
  );
  textarea.addEventListener(
    "blur",
    () => {
      api.closeSlashPopup();
      api.closeMentionPopup();
      api.closeChannelPopup();
      api.closeEmojiPopup();
    },
    { signal: st.signal },
  );
}
