/** Focus the first candidate that takes focus; null when none does. */
export function focusFirst(
  candidates: ReadonlyArray<HTMLElement | null | undefined>,
): HTMLElement | null {
  for (const el of candidates) {
    el?.focus();
    if (el != null && document.activeElement === el) return el;
  }
  return null;
}
