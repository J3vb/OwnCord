/**
 * Shared dialog accessibility helpers (DC-13).
 *
 * Generalizes the pattern UserProfilePopup pioneered — dialog semantics, a
 * Tab-cycling focus trap, and focus save/restore — so every modal applies the
 * same behavior instead of re-implementing (or forgetting) it. All listeners
 * register against the caller's AbortSignal, matching the component teardown
 * idiom used across the codebase.
 */

/** The elements a dialog's Tab cycle visits. */
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface DialogSemanticsOptions {
  /** Accessible name for the dialog (aria-label). */
  readonly label?: string;
  /** Id of the element naming the dialog (aria-labelledby); wins over label. */
  readonly labelledBy?: string;
}

/**
 * Stamp WAI-ARIA dialog semantics on a modal container: role="dialog",
 * aria-modal="true", and tabindex="-1" so the container itself can take
 * initial focus when it holds no focusable control.
 */
export function applyDialogSemantics(el: HTMLElement, opts: DialogSemanticsOptions = {}): void {
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("tabindex", "-1");
  if (opts.labelledBy !== undefined) {
    el.setAttribute("aria-labelledby", opts.labelledBy);
  } else if (opts.label !== undefined) {
    el.setAttribute("aria-label", opts.label);
  }
}

/**
 * Trap Tab/Shift+Tab inside `container` for as long as `signal` lives:
 * tabbing past the last focusable wraps to the first and vice versa. The
 * focusable set is queried per keystroke, so contents may change freely.
 */
export function trapFocus(container: HTMLElement, signal: AbortSignal): void {
  container.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) {
        // Nothing tabbable inside — keep focus on the container itself.
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      // Focus outside the set (e.g. on the container) also wraps to an edge.
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || active === container)) {
        e.preventDefault();
        first.focus();
      }
    },
    { signal },
  );
}

/**
 * Make exactly one cell in `container` tabbable (the first) and the rest
 * focusable only programmatically. Call after every render that replaces the
 * cell set — search results swap the cells out from under the tabindex, and a
 * grid with zero (or many) Tab stops breaks the "Tab enters the grid once"
 * contract.
 */
export function setRovingTabindex(container: HTMLElement, cellSelector: string): void {
  const cells = container.querySelectorAll<HTMLElement>(cellSelector);
  cells.forEach((cell, i) => {
    cell.setAttribute("tabindex", i === 0 ? "0" : "-1");
  });
}

/**
 * Roving-tabindex keyboard support for a flat list of option cells:
 * ArrowLeft/ArrowRight step, Home/End jump to the edges, and Enter/Space
 * activate the focused cell through its own click handler so keyboard and
 * mouse take the identical code path. The grid is deliberately treated as a
 * flat list — row-aware Up/Down would need layout knowledge the DOM doesn't
 * expose reliably.
 *
 * The listener lives on the container (which survives re-renders) and the
 * cell set is queried per keystroke, so callers may rebuild cells freely as
 * long as they re-run setRovingTabindex afterwards.
 */
export function enableRovingNavigation(
  container: HTMLElement,
  cellSelector: string,
  signal: AbortSignal,
): void {
  container.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      // Only keystrokes originating on a cell rove; the search input above
      // the grid keeps its native caret behavior for arrows and Home/End.
      const origin =
        e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(cellSelector) : null;
      if (origin === null) return;
      const cells = Array.from(container.querySelectorAll<HTMLElement>(cellSelector));
      const from = cells.indexOf(origin);
      if (from === -1) return;

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        origin.click();
        return;
      }

      let to: number;
      if (e.key === "ArrowRight") to = Math.min(from + 1, cells.length - 1);
      else if (e.key === "ArrowLeft") to = Math.max(from - 1, 0);
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = cells.length - 1;
      else return;

      e.preventDefault();
      // Move the single Tab stop along with focus so tabbing away and back
      // returns to the last visited cell, not the first.
      origin.setAttribute("tabindex", "-1");
      const target = cells[to]!;
      target.setAttribute("tabindex", "0");
      target.focus();
    },
    { signal },
  );
}

/**
 * Move initial focus into a just-opened dialog (its first focusable control,
 * else the container itself) and return a restorer that puts focus back on
 * whatever held it before — call the restorer on close. Capturing happens NOW,
 * so call this before anything inside the dialog grabs focus.
 */
export function focusDialog(container: HTMLElement): () => void {
  const previous = document.activeElement;
  const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  (firstFocusable ?? container).focus();
  return () => {
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
  };
}
