/**
 * The virtual member list's watch on its scroller: which ancestor scrolls, its
 * flying-scroll reports, and one ResizeObserver over the scroller and one row
 * of each height kind. It schedules nothing itself; every change it sees calls
 * `onChange`.
 */

import { Disposable } from "@lib/disposable";
import { listenForFlyingScroll } from "./scrollReport";
import { scrollParentOf } from "./memberListModel";

export interface ScrollWatch {
  /** Watch the scroller around `root`, keeping the current one while it still
   *  holds `root`. Until a scroller is found (the panel is built before its
   *  host appends it) `root` itself is watched, so connecting it reports. */
  bind(root: HTMLElement): void;
  /** The scroller being watched, or null. */
  scroller(): HTMLElement | null;
  /** Watch the first child of each height kind, so a height change that moves
   *  nothing else still reports. */
  sample(root: HTMLElement, kindByEl: WeakMap<Element, number>): void;
  destroy(): void;
}

export function createScrollWatch(onChange: () => void): ScrollWatch {
  let scroller: HTMLElement | null = null;
  let root: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  let binding: Disposable | null = null;
  const samples: (Element | null)[] = [null, null, null, null];
  const sizes = new WeakMap<Element, string>();

  // A scroller or a sampled row that changed size (collapse and expand, drag
  // resize, a font-size change) needs a frame. A sample's first report is only
  // its starting size, so a new sample never reports.
  function onResize(entries: readonly ResizeObserverEntry[]): void {
    let changed = false;
    for (const { target, contentRect } of entries) {
      const size = `${contentRect.width}x${contentRect.height}`;
      const before = sizes.get(target);
      sizes.set(target, size);
      if (before !== size && (before !== undefined || target === scroller || target === root)) {
        changed = true;
      }
    }
    if (changed) onChange();
  }

  function setScroller(next: HTMLElement | null): void {
    if (next === scroller) return;
    binding?.destroy();
    binding = null;
    if (scroller !== null) observer?.unobserve(scroller);
    scroller = next;
    if (next === null) return;
    if (root !== null) observer?.unobserve(root);
    const owner = new Disposable();
    binding = owner;
    listenForFlyingScroll(next, owner.signal, onChange);
    observer?.observe(next);
  }

  function bind(rootEl: HTMLElement): void {
    if (observer === null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
    }
    root = rootEl;
    if (scroller === null || !scroller.contains(rootEl)) {
      setScroller(scrollParentOf(rootEl));
      if (scroller === null) observer?.observe(rootEl);
    }
  }

  function sample(rootEl: HTMLElement, kindByEl: WeakMap<Element, number>): void {
    const first: (Element | null)[] = [null, null, null, null];
    for (const child of rootEl.children) {
      const kind = kindByEl.get(child);
      if (kind !== undefined && first[kind] === null) first[kind] = child;
    }
    first.forEach((el, kind) => {
      const old = samples[kind];
      if (el === old) return;
      if (old !== null && old !== undefined) observer?.unobserve(old);
      if (el !== null) observer?.observe(el);
      samples[kind] = el;
    });
  }

  function destroy(): void {
    binding?.destroy();
    binding = null;
    observer?.disconnect();
    observer = null;
    scroller = null;
    root = null;
    samples.fill(null);
  }

  return { bind, scroller: () => scroller, sample, destroy };
}
