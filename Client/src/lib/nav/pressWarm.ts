/**
 * Start loading a channel when the mouse button goes down on its row. The click
 * still opens it; a press that becomes a drag or leaves the row is dropped.
 * Mouse only: a touch press is the start of a scroll, and Enter is instant.
 */

import { cancelChannelWarm, warmChannel } from "./channelNavigation";

export function attachPressWarm(el: HTMLElement, channelId: number, signal: AbortSignal): void {
  el.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("button") !== null) return;
      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      warmChannel(channelId);
    },
    { signal },
  );
  const cancel = (): void => cancelChannelWarm(channelId);
  el.addEventListener("dragstart", cancel, { signal });
  el.addEventListener("pointercancel", cancel, { signal });
  el.addEventListener("pointerleave", cancel, { signal });
}
