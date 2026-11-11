import { ensureActionsBar } from "../../src/features/messaging/message-list/messageActionBar";

/** Build the hover bar of every rendered row under `root`, as a pointer hovering each would. */
export function hoverRows(root: ParentNode = document): void {
  for (const row of root.querySelectorAll(".message")) ensureActionsBar(row);
}

/** Build the hover bar of one row. */
export function hoverRow(row: Element | null): void {
  if (row !== null) ensureActionsBar(row);
}
