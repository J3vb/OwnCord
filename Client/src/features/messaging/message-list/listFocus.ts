/**
 * The message list's focus capture: the identity of the focused control in the
 * rendered window, so a rebuild can put focus back on its replacement.
 */
import { ROW_FOCUSABLE_SELECTOR } from "./messageActions";
import type { ListState } from "./listState";

export function createRowFocus(st: ListState) {
  /**
   * Stable identity of the focused control inside the rendered window, so a
   * virtualized rebuild can put focus back on its replacement (Q1 focus:
   * stable location through async update/removal). The row's own key survives
   * the rebuild because rows are keyed by message id; a control with its own
   * `data-testid` (the action buttons) is restored exactly, and a focusable
   * without one (a reaction chip, a reply bar, a link) is restored by its
   * position among the row's focusable controls. Null when focus is outside
   * the rendered window, so an unrelated rebuild never pulls focus back into
   * the list. Restoring never scrolls, so a reader scrolling away from the
   * focused row or a history-prepend anchor is not pulled back to it.
   */
  function captureRowFocus(): { own: string | null; row: string | null; index: number } | null {
    const active = document.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      st.contentContainer === null ||
      !st.contentContainer.contains(active)
    ) {
      return null;
    }
    const row = active.closest<HTMLElement>("[data-testid]");
    const index =
      row === null ? -1 : [...row.querySelectorAll(ROW_FOCUSABLE_SELECTOR)].indexOf(active);
    return { own: active.dataset.testid ?? null, row: row?.dataset.testid ?? null, index };
  }

  /** Put focus back on the captured control's replacement; false when it has none. */
  function restoreRowFocus(
    captured: { own: string | null; row: string | null; index: number } | null,
  ): boolean {
    if (captured === null || st.contentContainer === null) return false;
    let target: HTMLElement | null | undefined = null;
    if (captured.own !== null) {
      target = st.contentContainer.querySelector<HTMLElement>(`[data-testid="${captured.own}"]`);
    } else if (captured.row !== null && captured.index >= 0) {
      target = st.contentContainer
        .querySelector<HTMLElement>(`[data-testid="${captured.row}"]`)
        ?.querySelectorAll<HTMLElement>(ROW_FOCUSABLE_SELECTOR)
        .item(captured.index);
    }
    target?.focus({ preventScroll: true });
    return target !== null && target !== undefined;
  }

  return { captureRowFocus, restoreRowFocus };
}
