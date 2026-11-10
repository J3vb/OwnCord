/** The emoji picker for the self profile card's custom status. */

import { createLazyScreen } from "@lib/ui/lazyScreen";
import { MAX_CUSTOM_STATUS_LEN } from "@lib/presence/userStatus";
import { runeCount } from "@lib/text/nameLimits";
import type { CardSession } from "./selfProfileTypes";

// The picker loads on its first open, so its code stays out of the main-page chunk.
const emojiPickerScreen = createLazyScreen("emoji-picker", () => import("@components/EmojiPicker"));

export interface StatusEmojiPicker {
  /** Whether the picker is on screen right now. */
  isOpen(): boolean;
  /** Close it (and cancel a load in flight). `refocus` puts the caret back in the field. */
  close(refocus: boolean): void;
}

interface EmojiHost {
  readonly session: CardSession;
  readonly input: HTMLInputElement;
  readonly button: HTMLElement;
  /** Commit the typed text, as the field's own blur would. */
  readonly commit: () => void;
  /** Apply an owner update that was held back while the field or picker was busy. */
  readonly syncFromOwner: () => void;
  /** The text changed under the caret. */
  readonly onInserted: () => void;
}

export function attachEmojiPicker(host: EmojiHost): StatusEmojiPicker {
  const { session: s, input, button } = host;
  let picker: { element: HTMLDivElement; destroy(): void } | null = null;
  // Set while the picker's code loads: a second click cancels it, and so
  // does closing the card (the load resolving later mounts nothing).
  let pending: object | null = null;

  function close(refocus: boolean): void {
    pending = null;
    if (picker === null) return;
    picker.element.remove();
    picker.destroy();
    picker = null;
    button.setAttribute("aria-expanded", "false");
    if (refocus) {
      // Back in the field: its own blur commits the text later.
      if (s.isCurrent()) input.focus();
    } else {
      // The card (or the picker's availability) is going away without
      // returning to the field, so its blur will not commit what was typed.
      host.commit();
    }
    // An update held back while the picker was open applies now.
    if (s.isCurrent() && document.activeElement !== input) host.syncFromOwner();
  }

  /** Put `emoji` at the caret (replacing a selection), unless that would
   *  take the text past the server's limit. The input's own maxlength caps
   *  typing the same way, and counts the same units. */
  function insertEmoji(emoji: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + emoji + input.value.slice(end);
    if (runeCount(next) > MAX_CUSTOM_STATUS_LEN) return;
    input.value = next;
    const caret = start + emoji.length;
    input.setSelectionRange(caret, caret);
    host.onInserted();
  }

  function open(screen: typeof import("@components/EmojiPicker")): void {
    picker = screen.createEmojiPicker({
      // Custom statuses render as plain text, so a server emoji would show
      // as ":shortcode:".
      customEmoji: [],
      onSelect: (emoji, select) => {
        insertEmoji(emoji);
        if (select?.keepOpen !== true) close(true);
      },
      onClose: () => close(true),
    });
    picker.element.classList.add("spc-emoji-picker");
    s.card.appendChild(picker.element);
    button.setAttribute("aria-expanded", "true");
  }

  button.addEventListener(
    "click",
    () => {
      if (!s.enabled) return;
      if (picker !== null) {
        close(true);
        return;
      }
      if (pending !== null) {
        pending = null;
        return;
      }
      const ticket = {};
      pending = ticket;
      void emojiPickerScreen
        .load(() => pending === ticket)
        .then((screen) => {
          if (pending !== ticket || s.signal.aborted) return;
          pending = null;
          if (screen !== null) open(screen);
        });
    },
    { signal: s.signal },
  );
  // Keep the caret where it is: a press on the button must not blur the
  // input (and so must not commit half-typed text) before the picker opens.
  button.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault(), {
    signal: s.signal,
  });

  return { isOpen: () => picker !== null, close };
}
