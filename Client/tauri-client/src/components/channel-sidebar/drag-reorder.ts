/**
 * Channel drag-reorder — mouse-based drag-and-drop for channel reordering.
 * Uses mousedown/mousemove/mouseup (avoids WebView2 HTML5 DnD issues).
 * Admin/owner only.
 */

import { getCurrentUser } from "@stores/auth.store";
import { updateChannelPosition } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import type { ChannelReorderData } from "../ChannelSidebar";

// ── Drag state (mouse-based, avoids WebView2 HTML5 DnD issues) ──
interface DragState {
  channelId: number;
  sourceEl: HTMLElement;
  containerEl: HTMLElement;
  channels: readonly Channel[];
  onReorder: (reorders: readonly ChannelReorderData[]) => void;
}
let activeDrag: DragState | null = null;

/** Global mousemove/mouseup handlers for drag reordering. Registered once.
 *  Reference-counted so multiple sidebar instances share the same listeners
 *  and only the last destroy tears them down. */
let globalDragAc: AbortController | null = null;
let globalDragRefCount = 0;

export function ensureGlobalDragListeners(): void {
  globalDragRefCount++;
  if (globalDragAc !== null) {
    return;
  }
  globalDragAc = new AbortController();

  document.addEventListener("mousemove", (e) => {
    if (activeDrag === null) {
      return;
    }
    // Clear old indicators
    activeDrag.containerEl.querySelectorAll(".channel-drop-indicator").forEach((x) => {
      x.classList.remove("channel-drop-indicator");
    });

    // Find which channel item we're hovering over
    const items = activeDrag.containerEl.querySelectorAll("[data-drag-channel-id]");
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const targetId = Number((item as HTMLElement).dataset.dragChannelId);
        if (targetId !== activeDrag.channelId) {
          item.classList.add("channel-drop-indicator");
        }
        break;
      }
    }
  }, { signal: globalDragAc.signal });

  document.addEventListener("mouseup", (e) => {
    if (activeDrag === null) {
      return;
    }
    const drag = activeDrag;
    activeDrag = null;

    // Clean up visual state
    drag.sourceEl.classList.remove("dragging");
    document.body.classList.remove("channel-reordering");
    drag.containerEl.querySelectorAll(".channel-drop-indicator").forEach((x) => {
      x.classList.remove("channel-drop-indicator");
    });

    // Find drop target
    const items = drag.containerEl.querySelectorAll("[data-drag-channel-id]");
    let dropTargetId: number | null = null;
    let dropBefore = false;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        dropTargetId = Number((item as HTMLElement).dataset.dragChannelId);
        dropBefore = e.clientY < rect.top + rect.height / 2;
        break;
      }
    }

    if (dropTargetId === null || dropTargetId === drag.channelId) {
      return;
    }

    // Compute new order
    const orderedIds = drag.channels.map((ch) => ch.id);
    const dragIdx = orderedIds.indexOf(drag.channelId);
    if (dragIdx === -1) {
      return;
    }
    const withoutDrag = orderedIds.filter((id) => id !== drag.channelId);

    const targetIdx = withoutDrag.indexOf(dropTargetId);
    if (targetIdx === -1) {
      return;
    }
    const insertIdx = dropBefore ? targetIdx : targetIdx + 1;
    const reorderedIds = [
      ...withoutDrag.slice(0, insertIdx),
      drag.channelId,
      ...withoutDrag.slice(insertIdx),
    ];

    // Build reorder data and update store immediately
    const reorders: ChannelReorderData[] = [];
    for (let i = 0; i < reorderedIds.length; i++) {
      const id = reorderedIds[i];
      if (id === undefined) {
        continue;
      }
      const ch = drag.channels.find((c) => c.id === id);
      if (ch !== undefined && ch.position !== i) {
        reorders.push({ channelId: id, newPosition: i });
        updateChannelPosition(id, i);
      }
    }

    if (reorders.length > 0) {
      drag.onReorder(reorders);
    }
  }, { signal: globalDragAc.signal });
}

/** Make a channel element draggable via mousedown (admin/owner only). */
export function attachDragHandlers(
  el: HTMLElement,
  channel: Channel,
  containerEl: HTMLElement,
  channels: readonly Channel[],
  signal: AbortSignal,
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
): void {
  if (onReorderChannel === undefined) {
    return;
  }
  const user = getCurrentUser();
  const role = user?.role?.toLowerCase() ?? "";
  if (role !== "owner" && role !== "admin") {
    return;
  }

  ensureGlobalDragListeners();

  el.classList.add("channel-draggable");
  el.dataset.dragChannelId = String(channel.id);

  let pendingDrag: { startX: number; startY: number } | null = null;

  el.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) {
        return;
      }
      // Start tracking — only activate drag after movement threshold
      pendingDrag = { startX: e.clientX, startY: e.clientY };
    },
    { signal },
  );

  el.addEventListener(
    "mousemove",
    (e) => {
      if (pendingDrag === null || activeDrag !== null) {
        return;
      }
      const dx = Math.abs(e.clientX - pendingDrag.startX);
      const dy = Math.abs(e.clientY - pendingDrag.startY);
      // Require 5px movement to start drag (avoids hijacking clicks)
      if (dx + dy < 5) {
        return;
      }
      pendingDrag = null;
      activeDrag = {
        channelId: channel.id,
        sourceEl: el,
        containerEl,
        channels,
        onReorder: onReorderChannel,
      };
      el.classList.add("dragging");
      document.body.classList.add("channel-reordering");
    },
    { signal },
  );

  el.addEventListener(
    "mouseup",
    () => {
      pendingDrag = null;
    },
    { signal },
  );
}

/** Decrement global drag listener ref-count; tear down when no more sidebars. */
export function releaseGlobalDragListeners(containerEl?: HTMLElement): void {
  // Clear stale drag state if the destroyed sidebar owns the active drag
  if (containerEl !== undefined && activeDrag?.containerEl === containerEl) {
    activeDrag.sourceEl.classList.remove("dragging");
    document.body.classList.remove("channel-reordering");
    activeDrag = null;
  }
  globalDragRefCount = Math.max(0, globalDragRefCount - 1);
  if (globalDragRefCount === 0 && globalDragAc !== null) {
    globalDragAc.abort();
    globalDragAc = null;
  }
}
