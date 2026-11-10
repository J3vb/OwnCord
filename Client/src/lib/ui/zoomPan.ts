/**
 * Zoom and pan for a picture shown through a CSS transform: the image
 * lightbox and the video tiles (grid, focus, full screen, pop-out window).
 * The caller owns the element and its events; this keeps the scale and offset,
 * zooms towards a point and runs a mouse drag.
 *
 * The transform is `translate(x, y) scale(s)` about the element's centre, so
 * zooming by `f` towards a point `c` (from the centre as shown) moves the
 * offset by `-c * (f - 1)` and the point stays under the pointer.
 */

import { Disposable } from "../disposable";
import { createVideoZoomNavigator } from "./videoZoomNavigator";

/** Pixels a press may move and still count as a click, not a drag. */
export const CLICK_SLOP = 5;
/** Above this scale a press pans instead of clicking through. */
export const PAN_MIN_SCALE = 1.1;
/** One wheel notch zooms by this share of the current scale. */
const WHEEL_STEP = 0.15;

export interface ZoomPanOptions {
  readonly min: number;
  readonly max: number;
  /** Show the view: `transform` is a CSS transform, the identity at 1x. */
  apply(transform: string): void;
  /** Centre of the element as shown now (transform included), in client px. */
  centre(): { x: number; y: number };
  /** The element's size before the transform. Given, the picture always
   *  covers it: no pan past an edge, and zooming back to 1x recentres it. */
  bounds?(): { width: number; height: number };
  /** A drag started (true) or ended (false). */
  onDrag?(dragging: boolean): void;
}

export interface ZoomPan {
  readonly scale: number;
  /** The offset, in px. */
  readonly x: number;
  readonly y: number;
  /** One wheel notch towards the pointer: up zooms in, down out. */
  wheel(e: WheelEvent): void;
  /** Zoom to `scale` keeping the client point where it is. */
  zoomAt(scale: number, clientX: number, clientY: number): void;
  /** Zoom to `scale` about the current view, the offset unchanged. */
  setScale(scale: number): void;
  /** Move the view by a finger's step, in px. */
  panBy(dx: number, dy: number): void;
  /** On a primary press: start panning when zoomed in. True if it did. */
  press(e: MouseEvent): boolean;
  /** Whether the pointer moved past a click since the last press. */
  movedSincePress(x: number, y: number): boolean;
  /** End a drag in progress without moving. */
  cancelDrag(): void;
  /** Back to 1x, centred; ends a drag. */
  reset(): void;
}

export function createZoomPan(opts: ZoomPanOptions): ZoomPan {
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let pressX = 0;
  let pressY = 0;
  let drag: Disposable | null = null;

  const clamp = (s: number): number => Math.max(opts.min, Math.min(opts.max, s));

  function show(): void {
    const box = opts.bounds?.();
    if (box !== undefined) {
      const maxX = Math.max(0, ((scale - 1) * box.width) / 2);
      const maxY = Math.max(0, ((scale - 1) * box.height) / 2);
      // `|| 0`: no -0 offset (clamped to -0 at 1x) in the transform.
      panX = Math.max(-maxX, Math.min(maxX, panX)) || 0;
      panY = Math.max(-maxY, Math.min(maxY, panY)) || 0;
    }
    opts.apply(`translate(${panX}px, ${panY}px) scale(${scale})`);
  }

  function zoomAt(next: number, clientX: number, clientY: number): void {
    const to = clamp(next);
    const { x, y } = opts.centre();
    const factor = to / scale;
    panX -= (clientX - x) * (factor - 1);
    panY -= (clientY - y) * (factor - 1);
    scale = to;
    show();
  }

  function endDrag(): void {
    if (drag === null) return;
    drag.destroy();
    drag = null;
    opts.onDrag?.(false);
  }

  return {
    get scale() {
      return scale;
    },
    get x() {
      return panX;
    },
    get y() {
      return panY;
    },
    wheel(e) {
      const delta = e.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP;
      zoomAt(scale + delta * scale, e.clientX, e.clientY);
    },
    zoomAt,
    setScale(next) {
      scale = clamp(next);
      show();
    },
    panBy(dx, dy) {
      panX += dx;
      panY += dy;
      show();
    },
    press(e) {
      pressX = e.clientX;
      pressY = e.clientY;
      if (scale <= PAN_MIN_SCALE) return false;
      endDrag();
      // On the press's own document: a pop-out window has its own.
      const doc = (e.target as Node | null)?.ownerDocument ?? document;
      const startX = e.clientX - panX;
      const startY = e.clientY - panY;
      drag = new Disposable();
      const { signal } = drag;
      doc.addEventListener(
        "mousemove",
        (m) => {
          panX = m.clientX - startX;
          panY = m.clientY - startY;
          show();
        },
        { signal },
      );
      doc.addEventListener("mouseup", endDrag, { signal });
      opts.onDrag?.(true);
      return true;
    },
    movedSincePress(x, y) {
      return Math.abs(x - pressX) > CLICK_SLOP || Math.abs(y - pressY) > CLICK_SLOP;
    },
    cancelDrag: endDrag,
    reset() {
      endDrag();
      scale = 1;
      panX = 0;
      panY = 0;
      show();
    },
  };
}

/** A one-finger swipe at 1x this far sideways steps to the next picture. */
export const SWIPE_STEP = 60;
/** A one-finger swipe at 1x this far up or down closes the viewer. */
export const SWIPE_CLOSE = 80;
/** A swipe counts along one axis only when it moved this many times further
 *  along it than across it; a diagonal does nothing. */
const SWIPE_RATIO = 1.5;

/** What a one-finger swipe does while the view is not zoomed in. */
export interface TouchSwipe {
  /** Sideways: 1 for a swipe to the left (the next picture), -1 to the right. */
  readonly step?: (direction: 1 | -1) => void;
  /** Up or down. */
  readonly close?: () => void;
}

/**
 * Touch screens have no wheel or mouse drag: two fingers on `target` pinch
 * the view towards their midpoint, and one finger pans it once zoomed in.
 * At 1x a one-finger swipe goes to `swipe` instead: sideways steps, up or
 * down closes. A gesture that ever had a second finger is no swipe.
 * The element needs `touch-action: none` so the browser leaves the fingers
 * to this.
 */
export function bindTouchZoom(
  target: HTMLElement,
  view: ZoomPan,
  signal: AbortSignal,
  swipe?: TouchSwipe,
): void {
  const fingers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; scale: number } | null = null;
  // The finger a swipe may come from; null once a second finger joins.
  let swipeStart: { id: number; x: number; y: number } | null = null;

  const endSwipe = (e: PointerEvent): void => {
    const start = swipeStart;
    swipeStart = null;
    if (start === null || start.id !== e.pointerId || view.scale > PAN_MIN_SCALE) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const across = Math.abs(dx);
    const along = Math.abs(dy);
    if (across >= SWIPE_STEP && across > along * SWIPE_RATIO) swipe?.step?.(dx < 0 ? 1 : -1);
    else if (along >= SWIPE_CLOSE && along > across * SWIPE_RATIO) swipe?.close?.();
  };

  const pair = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
    const [a, b] = [...fingers.values()];
    return a === undefined || b === undefined ? null : [a, b];
  };

  target.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch") return;
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      target.setPointerCapture?.(e.pointerId);
      swipeStart =
        fingers.size === 1 && view.scale <= PAN_MIN_SCALE
          ? { id: e.pointerId, x: e.clientX, y: e.clientY }
          : null;
      const both = pair();
      if (fingers.size === 2 && both !== null) {
        const distance = Math.hypot(both[0].x - both[1].x, both[0].y - both[1].y);
        pinch = { distance, scale: view.scale };
      }
    },
    { signal },
  );
  target.addEventListener(
    "pointermove",
    (e) => {
      const prev = fingers.get(e.pointerId);
      if (prev === undefined) return;
      const next = { x: e.clientX, y: e.clientY };
      fingers.set(e.pointerId, next);
      const both = pair();
      if (pinch !== null && both !== null) {
        const distance = Math.hypot(both[0].x - both[1].x, both[0].y - both[1].y);
        if (pinch.distance <= 0) return;
        const midX = (both[0].x + both[1].x) / 2;
        const midY = (both[0].y + both[1].y) / 2;
        view.zoomAt((pinch.scale * distance) / pinch.distance, midX, midY);
      } else if (fingers.size === 1 && view.scale > PAN_MIN_SCALE) {
        view.panBy(next.x - prev.x, next.y - prev.y);
      }
    },
    { signal },
  );
  const lift = (e: PointerEvent): boolean => {
    if (!fingers.delete(e.pointerId)) return false;
    if (fingers.size < 2) pinch = null;
    return true;
  };
  target.addEventListener(
    "pointerup",
    (e) => {
      if (lift(e) && fingers.size === 0) endSwipe(e);
    },
    { signal },
  );
  target.addEventListener(
    "pointercancel",
    (e) => {
      lift(e);
      swipeStart = null;
    },
    { signal },
  );
}

/** Presses on the host's own controls never pan; the tile's select button
 *  covers the whole picture, so it does. */
const NO_PAN = "button:not(.video-cell-select), input";

/**
 * Ctrl + wheel zooms the video inside `host` towards the pointer and a drag
 * pans it, as in the image lightbox. A plain wheel is left to scroll the page.
 * The view reaches the <video> (or its canvas surface) through CSS variables
 * on `host` (video.css), so a video moved out of it shows unzoomed. A drag that pans is
 * no click: the host's click handlers never see it.
 */
export function bindVideoZoom(host: HTMLElement, signal: AbortSignal): ZoomPan {
  let updateNavigator: (() => void) | undefined;
  const view: ZoomPan = createZoomPan({
    min: 1,
    max: 8,
    apply: () => {
      if (signal.aborted) return;
      const zoomed = view.scale > 1;
      if (zoomed) {
        host.style.setProperty("--video-pan", `${view.x}px ${view.y}px`);
        host.style.setProperty("--video-scale", String(view.scale));
      } else {
        host.style.removeProperty("--video-pan");
        host.style.removeProperty("--video-scale");
      }
      host.classList.toggle("video-zoomed", zoomed);
      if (zoomed && host.dataset.streamType === "screenshare" && updateNavigator === undefined) {
        updateNavigator = createVideoZoomNavigator(host, view, signal);
      }
      updateNavigator?.();
    },
    centre: () => {
      const r = host.getBoundingClientRect();
      return { x: r.left + r.width / 2 + view.x, y: r.top + r.height / 2 + view.y };
    },
    bounds: () => ({ width: host.clientWidth, height: host.clientHeight }),
    onDrag: (dragging) => host.classList.toggle("video-panning", dragging),
  });
  let panned = false;

  host.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      view.wheel(e);
    },
    { signal, passive: false },
  );
  host.addEventListener(
    "mousedown",
    (e) => {
      panned = false;
      if (e.button !== 0 || (e.target as Element).closest(NO_PAN) !== null) return;
      panned = view.press(e);
      if (panned) e.preventDefault();
    },
    { signal },
  );
  host.addEventListener(
    "click",
    (e) => {
      if (!panned || !view.movedSincePress(e.clientX, e.clientY)) return;
      panned = false;
      e.stopPropagation();
      e.preventDefault();
    },
    { signal, capture: true },
  );
  signal.addEventListener("abort", () => view.cancelDrag(), { once: true });
  return view;
}
