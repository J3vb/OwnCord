/**
 * Keeps the characters typed while an overlay is still loading, so they reach
 * the overlay's input instead of the message box or nowhere.
 *
 * While held, plain printable keys (no Ctrl, Meta or Alt) are taken before any
 * other listener sees them. The first editable text field that takes focus
 * gets the held text appended and an `input` event, and the hold ends. The
 * caller ends it with the returned function when the open is cancelled.
 */

import { Disposable } from "../disposable";
import { isImeCommit } from "../text/ime";

const TEXT_INPUT_TYPES = new Set(["text", "search"]);

function textField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target.readOnly ? null : target;
  if (!(target instanceof HTMLInputElement) || target.readOnly || target.disabled) return null;
  return TEXT_INPUT_TYPES.has(target.type) ? target : null;
}

/** A key that types one character: no shortcut modifier, except AltGr
 *  (reported as Ctrl+Alt on Windows) which types @, € and the like. */
export function isTypedCharacter(e: KeyboardEvent): boolean {
  if (e.key.length !== 1 || e.metaKey) return false;
  const altGr = e.getModifierState("AltGraph") || (e.ctrlKey && e.altKey);
  return altGr || (!e.ctrlKey && !e.altKey);
}

/** Start holding typed keys. `seed` is text already typed (the key that
 *  opened the overlay). Returns the function that ends the hold and drops
 *  anything still held. */
export function holdTypeAhead(seed = ""): () => void {
  const owner = new Disposable();
  let held = seed;

  const onKeydown = (e: KeyboardEvent): void => {
    if (isImeCommit(e)) return;
    if (e.key === "Enter" || e.key === "Backspace") {
      // Meant for the overlay too: Enter must not send a draft, and
      // Backspace edits what is held.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Backspace") held = held.slice(0, -1);
      return;
    }
    if (!isTypedCharacter(e)) return;
    e.preventDefault();
    e.stopPropagation();
    held += e.key;
  };

  const onFocusIn = (e: FocusEvent): void => {
    const field = textField(e.target);
    if (field === null) return;
    owner.destroy();
    if (held === "") return;
    const end = field.value.length;
    field.setRangeText(held, end, end, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  window.addEventListener("keydown", onKeydown, { capture: true, signal: owner.signal });
  document.addEventListener("focusin", onFocusIn, { capture: true, signal: owner.signal });
  return () => owner.destroy();
}
