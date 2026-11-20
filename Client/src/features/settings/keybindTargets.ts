/**
 * Where a key was pressed, for the app-wide shortcuts (GlobalKeybinds.ts):
 * whether the focused element takes typed keys of its own.
 */

/** Controls that take keys of their own; typing on one of them stays there. */
const INTERACTIVE =
  'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], ' +
  '[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="tab"], ' +
  '[role="slider"], [role="radio"], [role="checkbox"], [role="switch"], [role="textbox"]';

/** Nothing that takes typed keys has focus. */
export function isIdleTarget(target: EventTarget | null): boolean {
  if (target === document.body || target === document.documentElement) return true;
  return target instanceof Element && target.closest(INTERACTIVE) === null;
}

/** Inside an open emoji or GIF picker, which focuses its own search field. */
export function inPicker(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".emoji-picker, .gif-picker") !== null;
}

/** A text-entry control, where a bare Alt+Arrow belongs to the field. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement && target.type !== "range") ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Whether the key was pressed inside the thread side panel. */
export function inThreadPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".thread-panel") !== null;
}

/** The message composer's textarea, where Alt+Up/Down still steps channels. */
export function isComposer(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.classList.contains("msg-textarea");
}
