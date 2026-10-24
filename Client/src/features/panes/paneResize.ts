/**
 * paneResize — a vertical drag handle on a pane's left edge. Dragging left
 * widens the pane; the arrow keys step it, Home and End jump to the limits.
 * The chosen width is saved as a pref on drop and on each key; the shown width
 * is that choice clamped to the limits and to the room the caller reports, so
 * a smaller window narrows the pane without losing the choice. It sets the
 * pane's width as a CSS custom property on `host`, which the CSS reads.
 */

import { Disposable } from "../../lib/disposable";
import { loadPref, savePref } from "../../lib/preferences";

export interface PaneResizeOptions {
  /** Gets the width property. */
  readonly host: HTMLElement;
  /** The custom property, e.g. `--call-chat-width`. */
  readonly property: string;
  readonly pref: string;
  readonly min: number;
  readonly max: number;
  readonly initial: number;
  /** The most the pane may take right now; 0 when unknown (no cap). */
  readonly room: () => number;
  readonly label: string;
  readonly className: string;
  readonly testId: string;
  /** Called as a drag starts, before the first move is clamped. */
  readonly onDragStart?: () => void;
}

export interface PaneResize {
  readonly handle: HTMLElement;
  /** Re-clamp the shown width (the room changed) and write it to the host. */
  apply(): void;
  /** End a drag in progress and save where it ended. Call it before taking
   *  the handle out: a removed capture target's lostpointercapture goes to
   *  the document, not the handle. */
  release(): void;
  /** End any drag and take the width property off the host. */
  clear(): void;
  destroy(): void;
}

const KEY_STEP = 16;

/** `width` within `min`-`max` and within `room` (0: no cap), never under `min`. */
export function clampPaneWidth(
  width: number,
  min: number,
  max: number,
  room: number,
  fallback: number,
): number {
  const cap = room > 0 ? Math.max(min, Math.min(max, room)) : max;
  const n = Number.isFinite(width) ? Math.round(width) : fallback;
  return Math.min(cap, Math.max(min, n));
}

export function createPaneResize(opts: PaneResizeOptions): PaneResize {
  const owner = new Disposable();
  const clamp = (w: number): number =>
    clampPaneWidth(w, opts.min, opts.max, opts.room(), opts.initial);
  /** The user's chosen width; the shown one may be narrower to fit. */
  let wanted = clampPaneWidth(
    loadPref<number>(opts.pref, opts.initial),
    opts.min,
    opts.max,
    0,
    opts.initial,
  );
  let shown = wanted;
  let dragPointer: number | null = null;
  let dragStartX = 0;
  let dragStartWidth = 0;

  const handle = document.createElement("div");
  handle.className = opts.className;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", opts.label);
  handle.setAttribute("aria-valuemin", String(opts.min));
  handle.setAttribute("aria-valuemax", String(opts.max));
  handle.setAttribute("data-testid", opts.testId);
  handle.tabIndex = 0;

  function apply(): void {
    shown = clamp(wanted);
    opts.host.style.setProperty(opts.property, `${shown}px`);
    handle.setAttribute("aria-valuenow", String(shown));
  }

  function choose(next: number): void {
    wanted = clamp(next);
    apply();
  }

  /** Finish the drag in progress (if any) and save where it ended. */
  function finishDrag(): void {
    if (dragPointer === null) return;
    const pointer = dragPointer;
    dragPointer = null;
    try {
      handle.releasePointerCapture(pointer);
    } catch {
      // Capture was already released (the pointer went away).
    }
    savePref(opts.pref, wanted);
  }

  function endDrag(e: PointerEvent): void {
    if (dragPointer === null || e.pointerId !== dragPointer) return;
    finishDrag();
  }

  owner.onEvent(handle, "pointerdown", (e) => {
    if (e.button !== 0 || dragPointer !== null) return;
    e.preventDefault();
    dragPointer = e.pointerId;
    dragStartX = e.clientX;
    dragStartWidth = shown;
    opts.onDragStart?.();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // No capture available: the drag still tracks moves over the handle.
    }
  });
  owner.onEvent(handle, "pointermove", (e) => {
    if (dragPointer === null || e.pointerId !== dragPointer) return;
    // The pane is right of the handle: dragging left makes it wider.
    choose(dragStartWidth + dragStartX - e.clientX);
  });
  owner.onEvent(handle, "pointerup", endDrag);
  owner.onEvent(handle, "pointercancel", endDrag);
  // Taking the handle away mid-drag drops capture and the pointerup never arrives.
  owner.onEvent(handle, "lostpointercapture", endDrag);
  owner.onEvent(handle, "keydown", (e) => {
    let next: number;
    if (e.key === "ArrowLeft") next = shown + KEY_STEP;
    else if (e.key === "ArrowRight") next = shown - KEY_STEP;
    else if (e.key === "Home") next = opts.min;
    else if (e.key === "End") next = opts.max;
    else return;
    e.preventDefault();
    choose(next);
    savePref(opts.pref, wanted);
  });

  return {
    handle,
    apply,
    release: finishDrag,
    clear(): void {
      finishDrag();
      opts.host.style.removeProperty(opts.property);
    },
    destroy(): void {
      finishDrag();
      owner.destroy();
      handle.remove();
      opts.host.style.removeProperty(opts.property);
    },
  };
}
