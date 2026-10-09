/** True while a modal dialog is open — the global shortcuts must not fire
 *  behind it and swallow the key from the dialog's own fields (#17). */
export function dialogOpen(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.modal-overlay, [aria-modal="true"]'),
  ).some(isShown);
}

/** A mounted-but-hidden dialog (the Settings panel inside its closed
 *  overlay) is not open: every ancestor must be displayed too. */
function isShown(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n !== null; n = n.parentElement) {
    if (n.hidden || getComputedStyle(n).display === "none") return false;
  }
  return true;
}
