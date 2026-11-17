/**
 * The voice-only cards: with no camera or screen share on show, the people
 * sit as compact cards in a box of their own that scrolls when they do not
 * fit, so the call view's control bar and View button stay put. The cards
 * are the avatar tiles themselves, moved, never rebuilt.
 */
import { createElement } from "@lib/dom";
import { fillStrip } from "./gridPeopleStrip";
import type { GridState, GridApi } from "./gridState";

export const CARDS_CLASS = "video-grid__cards";

export function createGridCards(
  st: GridState,
  api: GridApi,
  keepFocus: (cells: readonly HTMLElement[], move: () => void) => void,
) {
  let box: HTMLDivElement | null = null;

  /** Seat `cells` in the box, in order, the box among the tiles. */
  function seat(cells: readonly HTMLDivElement[]): void {
    if (st.root === null) return;
    box ??= createElement("div", { class: CARDS_CLASS });
    const el = box;
    if (el.parentNode !== st.root) api.beforeChrome(el);
    keepFocus(cells, () => fillStrip(el, cells));
  }

  /** The box goes; its cards go back to the main area. */
  function dissolve(): void {
    const el = box;
    if (el === null || el.parentNode !== st.root) return;
    const cells = [...el.children].filter((c): c is HTMLDivElement => c instanceof HTMLDivElement);
    keepFocus(cells, () => {
      el.remove();
      for (const cell of cells) api.beforeChrome(cell);
    });
  }

  function holds(el: HTMLElement): boolean {
    return box !== null && el.parentElement === box;
  }

  /** The grid is torn down: forget the box and what it held. */
  function reset(): void {
    box?.remove();
    box = null;
  }

  return { seat, dissolve, holds, reset };
}
