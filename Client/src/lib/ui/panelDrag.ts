/**
 * A phone panel that follows the finger: the channel drawer from the left and
 * the member panel from the right.
 *
 * While a panel swipe is live, the panel is drawn open (a peek: drawn, not
 * logically open) and shifted with `transform` so its edge tracks the finger;
 * the drawer's backdrop fades with it. On release the panel opens (or closes,
 * when an open one is dragged shut) past `max(60 px, 40 %` of its travel`)` or
 * on a flick, and otherwise snaps back. The open or close runs at release; the
 * short settle after it is visual only.
 *
 * Reduce motion turns the follow off: no drag starts, and the caller keeps
 * its plain distance rule.
 *
 * One drag at a time. A drag is cancelled (the panel returns to its last
 * stable state, and the lift opens nothing) by an interrupted swipe, the app
 * going to the background, the window leaving the phone layout, or a Back
 * while the finger is down; that Back then does what it does today (it closes
 * the panel on top, or in the Android app with nothing open, opens the
 * drawer). A turn that stays on the phone layout is not a cancel: the drag
 * keeps the travel it started with. A drag that throws is cancelled the same
 * way.
 */

import { Disposable } from "../disposable";
import { setOwnedTimeout } from "../dom";
import { createLogger } from "../logger";
import { motionReduced } from "./animatedStill";
import { onPhoneLayoutChange } from "./bottomSheet";

const log = createLogger("panel-drag");

/** The least a swipe must travel before letting go opens or closes a panel. */
export const PANEL_SWIPE_PX = 60;
/** The share of the panel's travel past which a slow drag opens it. */
export const DRAG_SHARE = 0.4;
/** A flick: at least this far, ... */
export const FLICK_MIN_PX = 30;
/** ... with this many samples in the window before the lift, ... */
export const FLICK_MIN_SAMPLES = 3;
export const FLICK_WINDOW_MS = 100;
/** ... spanning at least this long, ... */
export const FLICK_MIN_SPAN_MS = 16;
/** ... at this speed or more (px/ms) toward the drag's goal. */
export const FLICK_MIN_SPEED = 0.4;
/** How long the panel eases to where it ends up after the lift. */
export const SETTLE_MS = 160;

const DRAGGING = "panel-dragging";
const SETTLING = "panel-settling";

/** The drag's clock: a seam tests set. */
export const dragClock = { now: (): number => performance.now() };

export interface DragSample {
  /** Distance toward the drag's goal, as in `DragInput.dx`. */
  readonly dx: number;
  readonly t: number;
}

export interface DragInput {
  /** Distance moved toward the drag's goal: open for an opening drag, shut for a closing one. */
  readonly dx: number;
  /** How far the panel moves between closed and open (0 when unknown). */
  readonly travel: number;
  readonly samples: readonly DragSample[];
  /** The drag opens a closed panel (true) or closes an open one. */
  readonly opening: boolean;
  /** When the finger lifted; the last sample's time when absent. */
  readonly now?: number;
}

function isFlick(dx: number, samples: readonly DragSample[], now: number | undefined): boolean {
  const lastSample = samples.at(-1);
  if (dx < FLICK_MIN_PX || lastSample === undefined) return false;
  const end = now ?? lastSample.t;
  const recent = samples.filter((s) => end - s.t <= FLICK_WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (recent.length < FLICK_MIN_SAMPLES || first === undefined || last === undefined) return false;
  const span = last.t - first.t;
  if (span < FLICK_MIN_SPAN_MS) return false;
  return (last.dx - first.dx) / span >= FLICK_MIN_SPEED;
}

/** Where a drag leaves its panel once the finger lifts. */
export function dragOutcome(input: DragInput): "open" | "close" {
  const reached =
    input.dx >= Math.max(PANEL_SWIPE_PX, DRAG_SHARE * input.travel) ||
    isFlick(input.dx, input.samples, input.now);
  return reached === input.opening ? "open" : "close";
}

/** A panel a drag can move: its own state stays its own. */
export interface PeekTarget {
  /** The elements that move with the finger (connected ones only). */
  surfaces(): readonly HTMLElement[];
  /** What fades with the drag, if anything. */
  readonly backdrop: HTMLElement | null;
  /** Draw the panel open without opening it (on), or stop (off). */
  setPeek(on: boolean): void;
  /** Open (true) or close the panel for real, as its button would. */
  commit(open: boolean): void;
}

/** Something that may offer a peek target (a panel controller). */
export interface Peekable {
  peekTarget?(): PeekTarget | null;
}

export function peekOf(panel: Peekable | null | undefined): PeekTarget | null {
  return panel?.peekTarget?.() ?? null;
}

export interface PeekTargetInit {
  readonly surfaces: readonly HTMLElement[];
  readonly backdrop?: HTMLElement | null;
  readonly setPeek: (on: boolean) => void;
  readonly commit: (open: boolean) => void;
}

export function createPeekTarget(init: PeekTargetInit): PeekTarget {
  return {
    surfaces: () => init.surfaces.filter((el) => el.isConnected),
    backdrop: init.backdrop ?? null,
    setPeek: init.setPeek,
    commit: init.commit,
  };
}

type Side = "left" | "right";

interface Drag {
  readonly target: PeekTarget;
  readonly side: Side;
  readonly opening: boolean;
  /** The drag's lifetime, settle included: its listeners and its timer. */
  readonly owner: Disposable;
  /** While the finger is down: the Back listener. */
  readonly held: Disposable;
  readonly samples: DragSample[];
  surfaces: readonly HTMLElement[];
  travel: number;
  dead: boolean;
}

let active: Drag | null = null;

/**
 * Travel: from the screen edge to the panel's far edge, read while it peeks.
 * A box with no width (a closed panel, or no layout at all) counts for none.
 */
function measure(surfaces: readonly HTMLElement[], side: Side): number {
  let travel = 0;
  for (const el of surfaces) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0) continue;
    travel = Math.max(travel, side === "left" ? box.right : window.innerWidth - box.left);
  }
  return travel;
}

/** `dx` measured toward the drag's goal. */
function toward(drag: Drag, dx: number): number {
  const opensRightward = drag.side === "left";
  return opensRightward === drag.opening ? dx : -dx;
}

/** How open the panel is drawn (0 to 1) at `progress` px toward the goal. */
function openness(drag: Drag, progress: number): number {
  if (drag.travel <= 0) return drag.opening ? 0 : 1;
  const moved = Math.min(Math.max(progress, 0), drag.travel) / drag.travel;
  return drag.opening ? moved : 1 - moved;
}

function draw(drag: Drag, open: number): void {
  const shift = Math.round((1 - open) * drag.travel);
  const x = drag.side === "left" ? -shift : shift;
  for (const el of drag.surfaces) el.style.transform = `translateX(${x}px)`;
  if (drag.target.backdrop !== null) drag.target.backdrop.style.opacity = String(open);
}

/** End a drag where it is: no inline style, class or peek is left. */
function drop(drag: Drag): void {
  if (active === drag) active = null;
  if (drag.dead) return;
  drag.dead = true;
  drag.held.destroy();
  drag.owner.destroy();
  const backdrop = drag.target.backdrop;
  for (const el of drag.surfaces) {
    el.style.removeProperty("transform");
    el.classList.remove(DRAGGING, SETTLING);
  }
  backdrop?.style.removeProperty("opacity");
  backdrop?.classList.remove(DRAGGING, SETTLING);
  try {
    drag.target.setPeek(false);
  } catch (err) {
    log.warn("panel peek failed to end", err);
  }
}

function begin(target: PeekTarget, side: Side, opening: boolean): Drag | null {
  if (active !== null) drop(active);
  const drag: Drag = {
    target,
    side,
    opening,
    owner: new Disposable(),
    held: new Disposable(),
    surfaces: [],
    samples: [],
    travel: 0,
    dead: false,
  };
  active = drag;
  try {
    // Drawn open first: a closed panel has no width to measure.
    target.setPeek(true);
    const surfaces = target.surfaces();
    drag.surfaces = surfaces;
    drag.travel = measure(surfaces, side);
    // Back to where it starts in the same task, so the open layout never paints.
    draw(drag, opening ? 0 : 1);
    for (const el of [...surfaces, target.backdrop]) el?.classList.add(DRAGGING);
    // Back's own handling (lib/ui/backHistory.ts) runs as well, on the logical state.
    window.addEventListener("popstate", () => drop(drag), { signal: drag.held.signal });
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") drop(drag);
    };
    document.addEventListener("visibilitychange", onHidden, { signal: drag.owner.signal });
    onPhoneLayoutChange(() => drop(drag), drag.owner.signal);
  } catch (err) {
    log.warn("panel drag failed to start", err);
    drop(drag);
    return null;
  }
  return drag;
}

function follow(drag: Drag, dx: number): void {
  const progress = toward(drag, dx);
  const t = dragClock.now();
  drag.samples.push({ dx: progress, t });
  // Only the last moments matter to a flick.
  while ((drag.samples[0]?.t ?? t) < t - FLICK_WINDOW_MS) drag.samples.shift();
  draw(drag, openness(drag, progress));
}

function settle(drag: Drag, dx: number): void {
  drag.held.destroy();
  const outcome = dragOutcome({
    dx: toward(drag, dx),
    travel: drag.travel,
    samples: drag.samples,
    opening: drag.opening,
    now: dragClock.now(),
  });
  drag.target.commit(outcome === "open");
  if (drag.dead) return;
  for (const el of [...drag.surfaces, drag.target.backdrop]) {
    el?.classList.remove(DRAGGING);
    el?.classList.add(SETTLING);
  }
  draw(drag, outcome === "open" ? 1 : 0);
  setOwnedTimeout(drag.owner.signal, () => drop(drag), SETTLE_MS);
}

export interface PanelSwipe {
  /** The swipe went live, `dx` px from where it began. Always true: the swipe goes on. */
  start(dx: number): true;
  move(dx: number): void;
  /**
   * The swipe is over (`released` false: interrupted). True when a drag owned
   * it, settled or cancelled; false leaves the release to the caller's rule.
   */
  end(dx: number, released: boolean): boolean;
}

/**
 * The drag half of one swipe watcher. `getTarget` is asked when a swipe goes
 * live; null (or reduced motion) means no drag, and `end` returns false.
 */
export function panelSwipe(
  getTarget: () => PeekTarget | null,
  side: Side,
  opening: () => boolean,
): PanelSwipe {
  let drag: Drag | null = null;
  return {
    start(): true {
      drag = null;
      const target = motionReduced() ? null : getTarget();
      if (target !== null) drag = begin(target, side, opening());
      return true;
    },
    move(dx: number): void {
      const d = drag;
      if (d === null || d.dead) return;
      try {
        follow(d, dx);
      } catch (err) {
        log.warn("panel drag failed to follow", err);
        drop(d);
      }
    },
    end(dx: number, released: boolean): boolean {
      const d = drag;
      drag = null;
      if (d === null) return false;
      if (d.dead) return true;
      if (!released) {
        drop(d);
        return true;
      }
      try {
        settle(d, dx);
      } catch (err) {
        log.warn("panel drag failed to settle", err);
        drop(d);
      }
      return true;
    },
  };
}
