/** The drag handle on the expanded DM call panel's bottom edge, and the height it sets. */
import { savePref } from "@lib/prefs/preferences";
import { HEIGHT_PREF, MIN_HEIGHT, MESSAGES_MIN_HEIGHT, KEY_STEP } from "./dmCallShared";
import type { DmCallState } from "./dmCallState";

export function createDmCallResize(st: DmCallState): { applyHeight(): void } {
  /** Only the expanded panel resizes; collapsed and strip rows keep their own
   *  height. The stylesheet clamps the height to the chat column. */
  function applyHeight(): void {
    const expanded = st.root.classList.contains("dm-call-panel--expanded");
    st.resizer.hidden = !expanded;
    if (!expanded) {
      endDrag();
      st.root.style.removeProperty("--dcp-height");
      return;
    }
    if (st.savedHeight > 0)
      st.root.style.setProperty("--dcp-height", `${String(st.savedHeight)}px`);
    else st.root.style.removeProperty("--dcp-height");
    st.resizer.setAttribute("aria-valuemax", String(maxHeight()));
    st.resizer.setAttribute("aria-valuenow", String(drawnHeight()));
  }

  function drawnHeight(): number {
    return Math.round(st.root.getBoundingClientRect().height);
  }

  /** The tallest the panel may be: the chat column less its fixed rows (the
   *  header, typing line and composer, at their current heights) and room for
   *  a few messages. */
  function maxHeight(): number {
    let column = st.root.parentElement;
    while (column !== null && getComputedStyle(column).display === "contents") {
      column = column.parentElement;
    }
    if (column === null) return MIN_HEIGHT;
    let fixed = 0;
    for (const child of Array.from(column.children)) {
      if (child.contains(st.root) || parseFloat(getComputedStyle(child).flexGrow) > 0) continue;
      fixed += child.getBoundingClientRect().height;
    }
    const available = column.getBoundingClientRect().height - fixed - MESSAGES_MIN_HEIGHT;
    return Math.max(MIN_HEIGHT, Math.round(available));
  }

  /** Saves what is actually drawn: an audio-only panel never goes below its
   *  content (min-height: fit-content), so the saved height cannot sit under it. */
  function setHeight(height: number, max: number): void {
    st.savedHeight = Math.round(Math.max(MIN_HEIGHT, Math.min(height, max)));
    applyHeight();
    const drawn = drawnHeight();
    if (drawn > 0 && drawn !== st.savedHeight) {
      st.savedHeight = drawn;
      applyHeight();
    }
  }

  function endDrag(): void {
    if (st.drag === null) return;
    st.drag = null;
    st.root.classList.remove("dm-call-panel--resizing");
    savePref(HEIGHT_PREF, st.savedHeight);
  }

  st.resizer.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      st.drag = {
        startY: e.clientY,
        startHeight: st.root.getBoundingClientRect().height,
        max: maxHeight(),
      };
      st.root.classList.add("dm-call-panel--resizing");
      try {
        st.resizer.setPointerCapture(e.pointerId);
      } catch {
        // No capture (the pointer is already gone): moves over the handle still resize.
      }
    },
    st.resizeOpts,
  );

  st.resizer.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (st.drag !== null)
        setHeight(st.drag.startHeight + e.clientY - st.drag.startY, st.drag.max);
    },
    st.resizeOpts,
  );

  st.resizer.addEventListener("pointerup", endDrag, st.resizeOpts);

  st.resizer.addEventListener("pointercancel", endDrag, st.resizeOpts);

  st.resizer.addEventListener("lostpointercapture", endDrag, st.resizeOpts);

  st.resizer.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const step = e.key === "ArrowUp" ? -KEY_STEP : KEY_STEP;
      setHeight(st.root.getBoundingClientRect().height + step, maxHeight());
      savePref(HEIGHT_PREF, st.savedHeight);
    },
    st.resizeOpts,
  );

  // Double-click puts the default height back.
  st.resizer.addEventListener(
    "dblclick",
    () => {
      st.savedHeight = 0;
      applyHeight();
      savePref(HEIGHT_PREF, 0);
    },
    st.resizeOpts,
  );

  return { applyHeight };
}
