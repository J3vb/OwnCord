/**
 * Drag and drop on the Command Deck tab row: the drop rules by X position, the
 * wiring of server and folder tabs, and the "+N" button as a drop target that
 * sends an item to the end. The drop itself goes through the switcher's
 * `RailDrag`, so a drop acts on the reconciled layout as a menu does.
 */
import type { ItemRef, RailLayout } from "@lib/prefs/serverRailLayout";
import type { RailDrag } from "./railDrag";
import type { DropZone } from "./serverRailParts";

/** The drop zone by X: before, into, after in 25/50/25 when "into" is allowed, else halves. Width 0 gives "after", never "into". */
export function zoneOfX(e: DragEvent, el: HTMLElement, allowInto: boolean): DropZone {
  const rect = el.getBoundingClientRect();
  // A target that is no longer laid out: a wrong move is undone by one more
  // drag, a stray folder is not.
  if (rect.width === 0) return "after";
  const x = (e.clientX - rect.left) / rect.width;
  if (allowInto) {
    if (x < 0.25) return "before";
    if (x > 0.75) return "after";
    return "into";
  }
  return x < 0.5 ? "before" : "after";
}

/** Makes a server or folder tab a drag source and a drop target with X zones. */
export function wireTabDrag(drag: RailDrag, cell: HTMLElement, ref: ItemRef): void {
  drag.source(cell, ref);
  drag.target(cell, ref, { inFolder: false, zone: zoneOfX });
}

/** Makes "+N" a drop target that moves the dragged item to the end of the layout. Does nothing when the layout is empty. */
export function wireMoreDrop(drag: RailDrag, more: HTMLElement, layout: RailLayout): void {
  const last = layout.at(-1);
  if (last === undefined) return;
  const ref: ItemRef =
    last.kind === "server" ? { kind: "server", host: last.host } : { kind: "folder", id: last.id };
  drag.target(more, ref, { inFolder: false, zone: () => "after" });
}
