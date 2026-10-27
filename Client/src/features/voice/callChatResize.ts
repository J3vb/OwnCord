/**
 * callChatResize — the drag handle between the call grid and its chat (the
 * call view with the chat beside it, WP 6.1b). It sets `--call-chat-width` on
 * the chat column, which `.chat-area--call-chat` reads for its second track,
 * and keeps the grid at least CALL_GRID_MIN_PX wide. VideoModeController
 * attaches it while the split shows and refits it when the chat column resizes.
 */

import { shellText } from "../../i18n/shell";
import { clampPaneWidth, createPaneResize } from "../panes/paneResize";

export const CALL_CHAT_WIDTH_PREF = "callChatWidth";
export const CALL_CHAT_WIDTH_DEFAULT = 360;
export const CALL_CHAT_WIDTH_MIN = 280;
export const CALL_CHAT_WIDTH_MAX = 640;
/** The grid keeps at least this much beside the chat. */
export const CALL_GRID_MIN_PX = 360;

/** `width` within the limits, and narrow enough to leave the grid its room in
 *  a chat column `columnWidth` wide (0: not measured yet, no room cap). */
export function clampCallChatWidth(width: number, columnWidth: number): number {
  return clampPaneWidth(
    width,
    CALL_CHAT_WIDTH_MIN,
    CALL_CHAT_WIDTH_MAX,
    columnWidth > 0 ? columnWidth - CALL_GRID_MIN_PX : 0,
    CALL_CHAT_WIDTH_DEFAULT,
  );
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
  /** The chat column's width: measured on attach, then from the observer. */
  let columnWidth = 0;
  let destroyed = false;
  const pane = createPaneResize({
    host: chatColumn,
    property: "--call-chat-width",
    pref: CALL_CHAT_WIDTH_PREF,
    min: CALL_CHAT_WIDTH_MIN,
    max: CALL_CHAT_WIDTH_MAX,
    initial: CALL_CHAT_WIDTH_DEFAULT,
    room: () => (columnWidth > 0 ? columnWidth - CALL_GRID_MIN_PX : 0),
    label: shellText("callChat.resize"),
    className: "call-chat-resize",
    testId: "call-chat-resize",
    onDragStart: () => {
      columnWidth = chatColumn.getBoundingClientRect().width;
    },
  });

  return {
    attach(): void {
      if (destroyed) return;
      if (pane.handle.parentNode !== chatColumn) chatColumn.appendChild(pane.handle);
      columnWidth = chatColumn.getBoundingClientRect().width;
      pane.apply();
    },
    detach(): void {
      // Finish a drag before the handle goes: its capture loss won't reach it.
      pane.clear();
      pane.handle.remove();
    },
    refit(width: number): void {
      columnWidth = width;
      if (pane.handle.parentNode === chatColumn) pane.apply();
    },
    destroy(): void {
      destroyed = true;
      pane.destroy();
    },
  };
}
