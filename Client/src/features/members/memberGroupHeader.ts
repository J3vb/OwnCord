/**
 * A member list group header that folds its group: a click, Enter or Space
 * toggles it. Arrows, Home and End are left alone, so they keep walking the
 * rows only and the list's row navigation never lands on a header.
 */

/** Bind header `el` of group `key`; `signal` ends the binding with the element. */
export function bindGroupHeader(
  el: HTMLElement,
  key: string,
  toggle: (key: string) => void,
  signal: AbortSignal,
): void {
  el.addEventListener("click", () => toggle(key), { signal });
  el.addEventListener(
    "keydown",
    (e) => {
      // A held key folds once, not on every auto-repeat.
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      // Space would scroll the list, and Enter would reach the page.
      e.preventDefault();
      toggle(key);
    },
    { signal },
  );
}
