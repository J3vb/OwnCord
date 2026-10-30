/**
 * Horizontal swipes on a touch screen: the recognizer behind the drawer, the
 * member list and swipe-to-reply.
 *
 * A swipe starts only when the finger has moved sideways clearly more than
 * up or down, so a vertical scroll keeps working exactly as before. It never
 * starts from a text field, from something that scrolls sideways itself (a
 * code block, a wide embed), from the image viewer or a dialog or sheet, nor
 * while text is selected. Only touch pointers count; a second finger cancels.
 *
 * The surface should carry `touch-action: pan-y` so the browser leaves
 * horizontal moves to the page instead of cancelling the pointer.
 */

import { isBottomSheetOpen } from "./bottomSheet";
import { dialogOpen } from "./dialogOpen";

/** Sideways travel before a gesture can count as a swipe. */
export const SWIPE_START_PX = 10;
/** How many times larger the sideways move must be than the vertical one. */
export const SWIPE_DOMINANCE = 1.5;

/** True when a move of (dx, dy) from the touch-down point is a horizontal swipe. */
export function isHorizontalSwipe(dx: number, dy: number): boolean {
  const across = Math.abs(dx);
  return across > SWIPE_START_PX && across > SWIPE_DOMINANCE * Math.abs(dy);
}

const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const OWN_SURFACE = ".image-lightbox, .bottom-sheet-overlay";

function scrollsSideways(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth) return false;
  // Only an element the finger can scroll counts: a clipped one cannot.
  const overflow = getComputedStyle(el).overflowX;
  return overflow === "auto" || overflow === "scroll";
}

function selectingText(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * Whether a swipe may begin on `target`. `root` is the surface the swipe
 * belongs to: elements above it do not matter.
 */
export function swipeMayStartOn(target: Element, root: Element): boolean {
  if (target.closest(TEXT_ENTRY) !== null || target.closest(OWN_SURFACE) !== null) return false;
  if (isBottomSheetOpen() || dialogOpen() || selectingText()) return false;
  for (let el: Element | null = target; el !== null; el = el.parentElement) {
    if (scrollsSideways(el)) return false;
    if (el === root) break;
  }
  return true;
}

export interface SwipeHandlers<C> {
  /**
   * A touch went down on the surface. Return what to track, or null to leave
   * this touch alone. Runs after the common exclusions.
   */
  begin(target: Element, e: PointerEvent): C | null;
  /**
   * The move turned into a horizontal swipe, `dx` px from where it began
   * (negative is leftward). False drops the gesture.
   */
  start?(ctx: C, dx: number): boolean;
  /** The finger moved on while the swipe is live. */
  move?(ctx: C, dx: number): void;
  /** The swipe is over: `released` is false when it was interrupted. */
  end(ctx: C, dx: number, released: boolean): void;
}

interface Tracked<C> {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly ctx: C;
  live: boolean;
  dx: number;
}

/**
 * Listen for horizontal swipes on `root` until `signal` aborts. One gesture at
 * a time; a gesture that turns vertical is left to the browser.
 */
export function watchSwipes<C>(
  root: HTMLElement,
  signal: AbortSignal,
  handlers: SwipeHandlers<C>,
): void {
  let tracked: Tracked<C> | null = null;

  const finish = (released: boolean): void => {
    const t = tracked;
    tracked = null;
    if (t?.live === true) handlers.end(t.ctx, t.dx, released);
  };

  root.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch") return;
      if (!e.isPrimary) {
        // A second finger is a pinch or a two-finger scroll.
        finish(false);
        return;
      }
      finish(false);
      const target = e.target instanceof Element ? e.target : null;
      if (target === null || !swipeMayStartOn(target, root)) return;
      const ctx = handlers.begin(target, e);
      if (ctx === null) return;
      tracked = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, ctx, live: false, dx: 0 };
    },
    { signal },
  );

  root.addEventListener(
    "pointermove",
    (e) => {
      const t = tracked;
      if (t === null || e.pointerId !== t.pointerId) return;
      const dx = e.clientX - t.x;
      const dy = e.clientY - t.y;
      if (!t.live) {
        if (!isHorizontalSwipe(dx, dy)) {
          // Clearly vertical: a scroll, not ours.
          if (Math.abs(dy) > SWIPE_START_PX && Math.abs(dy) >= Math.abs(dx)) tracked = null;
          return;
        }
        if (selectingText() || handlers.start?.(t.ctx, dx) === false) {
          tracked = null;
          return;
        }
        t.live = true;
      }
      t.dx = dx;
      handlers.move?.(t.ctx, dx);
    },
    { signal },
  );

  root.addEventListener(
    "pointerup",
    (e) => {
      if (tracked !== null && e.pointerId === tracked.pointerId) finish(true);
    },
    { signal },
  );
  root.addEventListener(
    "pointercancel",
    (e) => {
      if (tracked !== null && e.pointerId === tracked.pointerId) finish(false);
    },
    { signal },
  );
  signal.addEventListener("abort", () => finish(false), { once: true });
}
