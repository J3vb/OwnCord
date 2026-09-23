/**
 * The Message Requests destination (B9-4, Q2): what the shell imports. The
 * inbox view itself loads on first open, like the Settings Safety tab, so it
 * stays out of the MainPage chunk.
 */

import { createElement } from "@lib/dom";

/** The requests destination's view builder (navigation/destinations.ts). */
export function buildInbox({
  signal,
  close,
}: {
  readonly signal: AbortSignal;
  readonly close: () => void;
}): HTMLElement {
  const root = createElement("div", { class: "requests-inbox", "data-testid": "requests-inbox" });
  import("./Inbox").then(
    ({ renderInbox }) => {
      if (!signal.aborted) renderInbox(root, signal);
    },
    // The view could not load: go back rather than leave an empty view open.
    () => {
      if (!signal.aborted) close();
    },
  );
  return root;
}
