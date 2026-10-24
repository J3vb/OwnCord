/**
 * callChatResize — the drag handle between the call grid and its chat (the
 * call view with the chat beside it, WP 6.1b). It sets `--call-chat-width` on
 * the chat column, which `.chat-area--call-chat` reads for its second track.
 * Dragged or keyboard (arrows, Home, End), saved as a pref, and clamped so the
 * grid always keeps room. VideoModeController attaches it while the split
 * shows and refits it when the chat column resizes.
 */

import { Disposable } from "@lib/disposable";
import { loadPref, savePref } from "@lib/preferences";
import { shellText } from "../../i18n/shell";

export const CALL_CHAT_WIDTH_PREF = "callChatWidth";
export const CALL_CHAT_WIDTH_DEFAULT = 360;
export const CALL_CHAT_WIDTH_MIN = 280;
export const CALL_CHAT_WIDTH_MAX = 640;
/** The grid keeps at least this much beside the chat. */
export const CALL_GRID_MIN_PX = 360;
const KEY_STEP = 16;

/** `width` within the limits, and narrow enough to leave the grid its room in
 *  a chat column `columnWidth` wide (0: not measured yet, no room cap). */
export function clampCallChatWidth(width: number, columnWidth: number): number {
  const room = columnWidth > 0 ? columnWidth - CALL_GRID_MIN_PX : CALL_CHAT_WIDTH_MAX;
  const max = Math.max(CALL_CHAT_WIDTH_MIN, Math.min(CALL_CHAT_WIDTH_MAX, room));
  const n = Number.isFinite(width) ? Math.round(width) : CALL_CHAT_WIDTH_DEFAULT;
  return Math.min(max, Math.max(CALL_CHAT_WIDTH_MIN, n));
}

export interface CallChatResize {
  /** Put the handle in the chat column and apply the saved width. */
  attach(): void;
  /** Take the handle out; the column's width property goes with it. */
  detach(): void;
  /** The chat column is now `columnWidth` wide: re-clamp the shown width. */
  refit(columnWidth: number): void;
  destroy(): void;
}

export function createCallChatResize(chatColumn: HTMLElement): CallChatResize {
  const owner = new Disposable();
  /** The user's chosen width; the shown one may be narrower to fit. */
  let wanted = clampCallChatWidth(
    loadPref<number>(CALL_CHAT_WIDTH_PREF, CALL_CHAT_WIDTH_DEFAULT),
    0,
  );
  let shown = wanted;
  let columnWidth = 0;
  let dragPointer: number | null = null;
  let dragStartX = 0;
  let dragStartWidth = 0;

  const handle = document.createElement("div");
  handle.className = "call-chat-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", shellText("callChat.resize"));
  handle.setAttribute("aria-valuemin", String(CALL_CHAT_WIDTH_MIN));
  handle.setAttribute("aria-valuemax", String(CALL_CHAT_WIDTH_MAX));
  handle.setAttribute("data-testid", "call-chat-resize");
  handle.tabIndex = 0;

  function apply(): void {
    shown = clampCallChatWidth(wanted, columnWidth);
    chatColumn.style.setProperty("--call-chat-width", `${shown}px`);
    handle.setAttribute("aria-valuenow", String(shown));
  }

  /** The user picked `next`: it becomes the wanted width as shown. */
  function choose(next: number): void {
    wanted = clampCallChatWidth(next, columnWidth);
    apply();
  }

  function endDrag(e: PointerEvent): void {
    if (dragPointer === null || e.pointerId !== dragPointer) return;
    dragPointer = null;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      // Capture was already released (the pointer went away).
    }
    savePref(CALL_CHAT_WIDTH_PREF, wanted);
  }

  owner.onEvent(handle, "pointerdown", (e) => {
    if (e.button !== 0 || dragPointer !== null) return;
    e.preventDefault();
    dragPointer = e.pointerId;
    dragStartX = e.clientX;
    dragStartWidth = shown;
    columnWidth = chatColumn.getBoundingClientRect().width;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // No capture available: the drag still tracks moves over the handle.
    }
  });
  owner.onEvent(handle, "pointermove", (e) => {
    if (dragPointer === null || e.pointerId !== dragPointer) return;
    // The chat is on the right: dragging left makes it wider.
    choose(dragStartWidth + dragStartX - e.clientX);
  });
  owner.onEvent(handle, "pointerup", endDrag);
  owner.onEvent(handle, "pointercancel", endDrag);
  // Leaving the split mid-drag drops capture and the pointerup never arrives.
  owner.onEvent(handle, "lostpointercapture", endDrag);
  owner.onEvent(handle, "keydown", (e) => {
    let next: number;
    if (e.key === "ArrowLeft") next = shown + KEY_STEP;
    else if (e.key === "ArrowRight") next = shown - KEY_STEP;
    else if (e.key === "Home") next = CALL_CHAT_WIDTH_MIN;
    else if (e.key === "End") next = CALL_CHAT_WIDTH_MAX;
    else return;
    e.preventDefault();
    choose(next);
    savePref(CALL_CHAT_WIDTH_PREF, wanted);
  });

  return {
    attach(): void {
      if (owner.signal.aborted) return;
      if (handle.parentNode !== chatColumn) chatColumn.appendChild(handle);
      columnWidth = chatColumn.getBoundingClientRect().width;
      apply();
    },
    detach(): void {
      handle.remove();
      chatColumn.style.removeProperty("--call-chat-width");
    },
    refit(width: number): void {
      columnWidth = width;
      if (handle.parentNode === chatColumn) apply();
    },
    destroy(): void {
      owner.destroy();
      handle.remove();
      chatColumn.style.removeProperty("--call-chat-width");
    },
  };
}
