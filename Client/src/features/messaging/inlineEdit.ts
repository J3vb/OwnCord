/**
 * The inline message editor (WP 3A-8): a textarea inside the message row, as
 * Discord does it. Lazy — loaded through inlineEditLoader.ts, so neither the
 * module nor its copy ships in the main-page chunk.
 *
 * One session owns one textarea. MessageList moves that same node into every
 * row it builds for the message, so the value, undo stack, selection and focus
 * survive a patch or a scroll out of the window and back. The session owns its
 * own listeners (a row owner would take them down with the row).
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/ime";
import { createElement } from "@lib/dom";
import { inlineEditText } from "../../i18n/inlineEdit";
import { replaceEmojiShortcodes } from "./shortcodes";
import { FORMAT_MARKERS, wrapWithMarker } from "./markdownMarkers";
import { MAX_MESSAGE_LEN } from "./messageLimits";

export interface InlineEditOptions {
  readonly messageId: number;
  readonly text: string;
  /** The cleaned, non-empty, within-limit text to save. */
  readonly onSave: (content: string) => void;
  readonly onCancel: () => void;
  /** Save with the text cleared: the host offers to delete the message. */
  readonly onEmpty: () => void;
}

export interface InlineEditSession {
  /** The editor's root; MessageList hosts it inside the row. */
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  /** Show (or with null clear) the inline error line. */
  setError(text: string | null): void;
  /** Focus the textarea with the caret after the last character. */
  focusEnd(): void;
  destroy(): void;
}

export function createInlineEdit(o: InlineEditOptions): InlineEditSession {
  const disposable = new Disposable();
  const { signal } = disposable;
  const id = o.messageId;

  const element = createElement("div", { class: "msg-inline-edit" });
  // Never the composer's `msg-textarea` class: GlobalKeybinds treats that as
  // the composer.
  const textarea = createElement("textarea", {
    class: "msg-inline-edit-input",
    "data-testid": `msg-edit-input-${id}`,
    "aria-label": inlineEditText("label"),
    rows: "1",
  });
  textarea.value = o.text;

  const hint = createElement("div", { class: "msg-inline-edit-hint" });
  const cancelLink = createElement(
    "button",
    {
      class: "msg-inline-edit-link",
      type: "button",
      "data-testid": `msg-edit-cancel-${id}`,
    },
    inlineEditText("hint.cancel"),
  );
  const saveLink = createElement(
    "button",
    {
      class: "msg-inline-edit-link",
      type: "button",
      "data-testid": `msg-edit-save-${id}`,
    },
    inlineEditText("hint.save"),
  );
  hint.append(
    `${inlineEditText("hint.escapeTo")} `,
    cancelLink,
    ` ${inlineEditText("hint.separator")} ${inlineEditText("hint.enterTo")} `,
    saveLink,
  );

  const errorId = `msg-edit-error-${id}`;
  const error = createElement("div", {
    class: "msg-inline-edit-error",
    id: errorId,
    role: "alert",
  });
  error.hidden = true;
  element.append(textarea, hint, error);

  function resize(): void {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function setError(text: string | null): void {
    error.textContent = text ?? "";
    error.hidden = text === null;
    // The textarea points at the message while it is shown, so a screen reader
    // reads it with the field and not only as a one-off live announcement.
    if (text === null) {
      textarea.removeAttribute("aria-invalid");
      textarea.removeAttribute("aria-describedby");
    } else {
      textarea.setAttribute("aria-invalid", "true");
      textarea.setAttribute("aria-describedby", errorId);
    }
  }

  function save(): void {
    const content = replaceEmojiShortcodes(textarea.value.trim());
    if (content.length === 0) {
      o.onEmpty();
      return;
    }
    // Code points, which is what the server counts (as the composer does).
    if ([...content].length > MAX_MESSAGE_LEN) {
      setError(inlineEditText("error.tooLong", { max: String(MAX_MESSAGE_LEN) }));
      return;
    }
    setError(null);
    o.onSave(content);
  }

  textarea.addEventListener(
    "input",
    () => {
      resize();
      setError(null);
    },
    { signal },
  );
  textarea.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const marker = FORMAT_MARKERS[e.key.toLowerCase()];
        if (marker !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          const r = wrapWithMarker(
            textarea.value,
            textarea.selectionStart,
            textarea.selectionEnd,
            marker,
          );
          textarea.value = r.value;
          textarea.selectionStart = r.selectionStart;
          textarea.selectionEnd = r.selectionEnd;
          resize();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // A CJK IME commits its candidate on Enter (isComposing, or keyCode 229).
        if (isImeCommit(e)) return;
        e.preventDefault();
        save();
        return;
      }
      // An Escape that cancels is used up: the app-wide Escape (mark the
      // channel read) leaves a prevented key alone.
      if (e.key === "Escape") {
        // Escape during IME composition cancels the composition, not the edit.
        if (isImeCommit(e)) return;
        e.preventDefault();
        o.onCancel();
      }
    },
    { signal },
  );
  cancelLink.addEventListener("click", () => o.onCancel(), { signal });
  saveLink.addEventListener("click", save, { signal });

  return {
    element,
    textarea,
    setError,
    focusEnd(): void {
      resize();
      textarea.focus({ preventScroll: true });
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    },
    destroy(): void {
      disposable.destroy();
      element.remove();
    },
  };
}
