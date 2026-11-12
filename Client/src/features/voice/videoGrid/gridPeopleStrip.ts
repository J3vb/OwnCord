/**
 * The participant strip: while a camera or screen share is shown (in focus
 * too), the people without video leave the packed area and sit in a strip
 * of compact tiles, at the bottom or (on a very wide grid) down the right.
 * The cells are the avatar tiles themselves, moved, never rebuilt.
 */
import { createElement } from "@lib/dom";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { voiceText } from "../../../i18n/voice";
import type { GridState, GridApi } from "./gridState";

export const STRIP_CLASS = "video-people-strip";
const AVATAR_CLASS = "video-cell--avatar";

/** A grid wider than this (width over height) takes the strip on its right:
 *  a bottom strip would eat height from tiles that are already short. */
export const SIDE_STRIP_RATIO = 2.4;

/** Height of the bottom strip and width of the side column, in px. The
 *  tiles keep their size; a long list scrolls. */
export const BOTTOM_STRIP_PX = 96;
export const SIDE_STRIP_PX = 200;

/** The least the video tiles keep along the strip's axis: under it the
 *  people stay in the main area. */
export const MIN_MAIN_PX = 180;

/** What the strip takes from the main area. */
export interface StripSpace {
  /** Whether the strip is in use (even when the view toggle hides it). */
  active: boolean;
  side: boolean;
  /** Width taken from the right, height taken from the bottom. */
  w: number;
  h: number;
}

const NO_STRIP: StripSpace = { active: false, side: false, w: 0, h: 0 };

export const isAvatarCell = (el: HTMLElement): boolean => el.classList.contains(AVATAR_CLASS);

/** Leave the packed place and size behind. */
function clearPlace(el: HTMLElement): void {
  el.style.left = "";
  el.style.top = "";
  el.style.width = "";
  el.style.height = "";
  el.classList.remove("video-cell--no-room");
}

/** Seat the cells in the strip, in order, reusing the elements; anything
 *  else left in it (a cell of an earlier grid) goes. */
function fillStrip(el: HTMLDivElement, cells: readonly HTMLDivElement[]): void {
  for (const child of Array.from(el.children)) {
    if (!(cells as readonly Element[]).includes(child)) child.remove();
  }
  cells.forEach((cell, i) => {
    if (el.children[i] === cell) return;
    clearPlace(cell);
    el.insertBefore(cell, el.children[i] ?? null);
  });
}

/** What the strip would take of a `cw` x `ch` grid whose bar takes
 *  `barSpace`: nothing when the video tiles would keep under MIN_MAIN_PX. */
function fit(cw: number, ch: number, barSpace: number, visible: boolean): StripSpace {
  const side = !isPhoneLayout() && cw / ch > SIDE_STRIP_RATIO;
  const w = visible && side ? SIDE_STRIP_PX : 0;
  const h = visible && !side ? BOTTOM_STRIP_PX : 0;
  if (cw - w < MIN_MAIN_PX || ch - barSpace - h < MIN_MAIN_PX) return NO_STRIP;
  return { active: true, side, w, h };
}

export function createPeopleStrip(st: GridState, api: GridApi) {
  let strip: HTMLDivElement | null = null;
  let last: StripSpace = NO_STRIP;

  function ensureStrip(): HTMLDivElement {
    strip ??= createElement("div", {
      class: STRIP_CLASS,
      role: "group",
      "aria-label": voiceText("grid.peopleStrip"),
    });
    return strip;
  }

  /** The people cells in layout order. */
  function peopleCells(): HTMLDivElement[] {
    const cells: HTMLDivElement[] = [];
    for (const person of st.people) {
      const cell = st.personCells.get(person.userId);
      if (cell !== undefined) cells.push(cell);
    }
    return cells;
  }

  /** Run a move of cells and give a control the user was on its focus back. */
  function keepFocus(cells: readonly HTMLElement[], move: () => void): void {
    const active = api.doc().activeElement;
    const held =
      active instanceof HTMLElement && cells.some((c) => c.contains(active)) ? active : null;
    move();
    if (held !== null && held.isConnected) held.focus({ preventScroll: true });
  }

  /** The strip goes; its cells go back to the main area. */
  function dissolve(): void {
    const el = strip;
    last = NO_STRIP;
    if (el === null || el.parentNode !== st.root) return;
    const cells = [...el.children].filter((c): c is HTMLDivElement => c instanceof HTMLDivElement);
    keepFocus(cells, () => {
      el.remove();
      for (const cell of cells) {
        clearPlace(cell);
        api.beforeChrome(cell);
      }
    });
  }

  /** Whether the layout wants the strip: a video tile shown and people
   *  without video to seat. */
  function wanted(shown: readonly HTMLElement[]): boolean {
    return st.personCells.size > 0 && shown.some((el) => !isAvatarCell(el));
  }

  /** The call view's "Show participant strip" toggle; the strip is always on
   *  where the host has no such toggle. */
  function stripOn(): boolean {
    return !st.callView || st.viewOn.strip;
  }

  /** Seat the strip for the grid's size, or take it away, and say how much
   *  of the main area it takes. */
  function seat(
    cw: number,
    ch: number,
    shown: readonly HTMLElement[],
    barSpace: number,
  ): StripSpace {
    if (st.root === null) return NO_STRIP;
    // No size to lay out in (a window moving, a hidden panel): leave things be.
    const cells = peopleCells();
    if (cw <= 0 || ch <= 0) {
      const el = strip;
      if (el?.parentNode !== st.root) return NO_STRIP;
      keepFocus(cells, () => fillStrip(el, cells));
      return last;
    }
    const space = wanted(shown)
      ? fit(cw, ch, barSpace, stripOn() && cells.some((c) => !c.hidden))
      : NO_STRIP;
    if (!space.active) {
      dissolve();
      return NO_STRIP;
    }
    const el = ensureStrip();
    if (el.parentNode !== st.root) api.beforeChrome(el);
    keepFocus(cells, () => fillStrip(el, cells));
    el.hidden = space.w === 0 && space.h === 0;
    el.classList.toggle(`${STRIP_CLASS}--side`, space.side);
    last = space;
    return space;
  }

  /** Put the strip where `space` says, in the grid's own box, above the call
   *  bar's room (`bottomGap`). */
  function place(space: StripSpace, cw: number, ch: number, bottomGap: number): void {
    if (strip === null || !space.active) return;
    const usable = ch - bottomGap;
    const box = strip.style;
    box.left = `${space.side ? cw - space.w : 0}px`;
    box.top = `${space.side ? 0 : usable - space.h}px`;
    box.width = `${space.side ? space.w : cw}px`;
    box.height = `${space.side ? usable : space.h}px`;
  }

  /** Whether the cell sits in the strip. */
  function holds(el: HTMLElement): boolean {
    return strip !== null && el.parentElement === strip;
  }

  /** The grid is torn down: forget the strip and what it held. */
  function reset(): void {
    strip?.remove();
    strip = null;
    last = NO_STRIP;
  }

  return { seat, place, holds, keepFocus, reset };
}
