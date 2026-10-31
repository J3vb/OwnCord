/** True while a modal dialog is open — the global shortcuts must not fire
 *  behind it and swallow the key from the dialog's own fields (#17). */
export function dialogOpen(): boolean {
  return displayedDialogs().length > 0;
}

/**
 * The dialogs on screen in document order, last on top. `outside` names
 * surfaces whose dialogs do not count (a selector), for a caller that tracks
 * those itself.
 */
export function displayedDialogs(outside?: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.modal-overlay, [aria-modal="true"]'),
  ).filter((el) => isDisplayed(el) && (outside === undefined || el.closest(outside) === null));
}

/**
 * Press Escape on the dialog on top, as the keyboard would: from the focused
 * control when focus is inside it, else from the dialog itself. Whatever the
 * dialog does with Escape (close, ask first, refuse) is what happens.
 */
export function dismissTopDialog(outside?: string): void {
  const top = displayedDialogs(outside).at(-1);
  if (top !== undefined) pressEscapeIn(top);
}

/** Press Escape inside `surface`: from the focused control when focus is in it, else from the surface. */
export function pressEscapeIn(surface: HTMLElement): void {
  const focused = document.activeElement;
  const target = focused instanceof Element && surface.contains(focused) ? focused : surface;
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

/** A mounted-but-hidden dialog (the Settings panel inside its closed
 *  overlay) is not open: every ancestor must be displayed too. */
export function isDisplayed(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n !== null; n = n.parentElement) {
    if (n.hidden || getComputedStyle(n).display === "none") return false;
  }
  return true;
}
