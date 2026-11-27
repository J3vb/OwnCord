// Touch pointer events for the swipe tests. jsdom's PointerEvent defaults
// isPrimary to false and pointerType to "", so both are always spelled out.

import { dragClock } from "../../src/lib/ui/panelDrag";

export interface TouchInit {
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly isPrimary?: boolean;
}

export function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  target: Element,
  x: number,
  y: number,
  init: TouchInit = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: init.pointerId ?? 1,
      pointerType: init.pointerType ?? "touch",
      isPrimary: init.isPrimary ?? true,
    }),
  );
}

/**
 * Down at `from`, `steps` moves to `to` that are `msPerStep` apart on the panel
 * drag's clock, and up with the last move; the drag's clock is put back after.
 */
function drive(
  target: Element,
  from: readonly [number, number],
  to: readonly [number, number],
  { steps, msPerStep }: TimedSteps,
  init: TouchInit,
): void {
  const real = dragClock.now;
  let t = real();
  dragClock.now = () => t;
  try {
    pointer("pointerdown", target, from[0], from[1], init);
    for (let i = 1; i <= steps; i++) {
      t += msPerStep;
      const x = from[0] + ((to[0] - from[0]) * i) / steps;
      const y = from[1] + ((to[1] - from[1]) * i) / steps;
      pointer("pointermove", target, x, y, init);
    }
    pointer("pointerup", target, to[0], to[1], init);
  } finally {
    dragClock.now = real;
  }
}

export interface TimedSteps {
  readonly steps: number;
  readonly msPerStep: number;
}

/**
 * A finger down at (x0, y0), moved to (x1, y1) in a few steps, and lifted, all
 * in one instant: the drag's clock stands still, so it is never a flick.
 */
export function swipe(
  target: Element,
  from: readonly [number, number],
  to: readonly [number, number],
  init: TouchInit = {},
): void {
  drive(target, from, to, { steps: 4, msPerStep: 0 }, init);
}

/** A swipe whose moves are `msPerStep` apart on the drag's clock, so its speed counts. */
export function swipeTimed(
  target: Element,
  from: readonly [number, number],
  to: readonly [number, number],
  timing: TimedSteps,
  init: TouchInit = {},
): void {
  drive(target, from, to, timing, init);
}

/** The app goes to the background (and comes straight back): a drag in progress or settling ends. */
export function sendAppToBackground(): void {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  delete (document as { visibilityState?: string }).visibilityState;
}
