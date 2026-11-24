/**
 * Drag and drop for a server switcher: draggable items, drop targets with
 * before/after/into markers, and the one root that catches drops missing
 * every target. Each renderer makes its own; listeners carry no signal and die
 * with their elements.
 */

import type { ItemRef } from "@lib/prefs/serverRailLayout";
import { sameItem, zoneOf, type DropZone } from "./serverRailParts";
import { applyDrop, type RailMutations } from "./serverRailMenus";

/** Where on a target a drop lands; `zoneOf` (by Y) unless a target passes its own. */
type ZoneFn = (e: DragEvent, el: HTMLElement, allowInto: boolean) => DropZone;

interface TargetOptions {
  readonly inFolder: boolean;
  readonly zone?: ZoneFn;
}

export interface RailDrag {
  readonly source: (el: HTMLElement, ref: ItemRef) => void;
  readonly target: (el: HTMLElement, ref: ItemRef, opts: TargetOptions) => void;
  /** The one element whose drops that miss every target are caught, and under which markers are
   *  cleared. Call it once per switcher: each call adds the root's listeners again. */
  readonly root: (el: HTMLElement) => void;
}

export function createRailDrag(mutations: RailMutations): RailDrag {
  let dragging: ItemRef | null = null;
  let rootEl: HTMLElement | null = null;

  function clearIndicators(): void {
    if (rootEl === null) return;
    for (const el of rootEl.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
      el.classList.remove("drop-before", "drop-after", "drop-into");
    }
  }

  function source(el: HTMLElement, ref: ItemRef): void {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragging = ref;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", ref.kind === "server" ? ref.host : ref.id);
      }
    });
    el.addEventListener("dragend", () => {
      dragging = null;
      clearIndicators();
    });
  }

  /** Make `wrapper` a drop target for `ref`; a centre drop joins or creates a folder where allowed. */
  function target(wrapper: HTMLElement, ref: ItemRef, opts: TargetOptions): void {
    const zoneAt = opts.zone ?? zoneOf;
    const intoAllowed = (): boolean =>
      dragging !== null &&
      dragging.kind === "server" &&
      !(ref.kind === "server" && opts.inFolder) &&
      !(ref.kind === "server" && dragging.host === ref.host);
    wrapper.addEventListener("dragover", (e) => {
      if (dragging === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearIndicators();
      wrapper.classList.add(`drop-${zoneAt(e, wrapper, intoAllowed())}`);
    });
    wrapper.addEventListener("dragleave", (e) => {
      if (e.relatedTarget instanceof Node && wrapper.contains(e.relatedTarget)) return;
      wrapper.classList.remove("drop-before", "drop-after", "drop-into");
    });
    wrapper.addEventListener("drop", (e) => {
      const from = dragging;
      if (from === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (!wrapper.isConnected) {
        // Removed by a rebuild during this dispatch: it cannot be measured, so
        // nothing is committed.
        dragging = null;
        clearIndicators();
        wrapper.classList.remove("drop-before", "drop-after", "drop-into");
        return;
      }
      const zone = zoneAt(e, wrapper, intoAllowed());
      dragging = null;
      clearIndicators();
      if (from.kind === ref.kind && sameItem(from, ref)) return;
      applyDrop(from, ref, zone, mutations);
    });
  }

  function root(el: HTMLElement): void {
    rootEl = el;
    // Drops that miss every item must not leave an indicator behind.
    el.addEventListener("dragover", (e) => {
      if (dragging !== null) e.preventDefault();
    });
    el.addEventListener("drop", () => {
      dragging = null;
      clearIndicators();
    });
  }

  return { source, target, root };
}
