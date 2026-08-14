/**
 * Channel drag-reorder — mouse-based drag-and-drop for channel reordering.
 * Uses mousedown/mousemove/mouseup (avoids WebView2 HTML5 DnD issues).
 * Gated on MANAGE_CHANNELS, like every other channel-management affordance.
 */

import { channelsStore, updateChannelPosition } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import type { ChannelReorderData } from "../ChannelSidebar";
import { canManageChannels } from "@lib/permissions";

// ── Drag state (mouse-based, avoids WebView2 HTML5 DnD issues) ──
interface DragState {
  channelId: number;
  sourceEl: HTMLElement;
  containerEl: HTMLElement;
  channels: readonly Channel[];
  onReorder: (reorders: readonly ChannelReorderData[]) => void;
  /** The signal of the sidebar that started this drag, so its teardown can
   *  clear the in-flight visual state without touching another sidebar's. */
  owner: AbortSignal;
}
let activeDrag: DragState | null = null;

/** Global mousemove/mouseup handlers for drag reordering, shared by every
 *  sidebar instance. Ownership is tracked per AbortSignal — the sidebar's
 *  lifetime controller — not per attached channel row: attachDragHandlers runs
 *  once per row per render, and the per-row ref-count this replaced meant a
 *  sidebar took N references its single destroy could never return, so the two
 *  document listeners lived for the rest of the process (the KNOWN BUG
 *  drag-reorder.test.ts pinned until this fix). An owner's release is its
 *  signal's abort — the same AbortController teardown idiom as
 *  {@link ../../lib/disposable} — so there is no separate release call to
 *  forget or miscount. */
const listenerOwners = new Set<AbortSignal>();
let globalDragAc: AbortController | null = null;

function releaseOwner(owner: AbortSignal): void {
  listenerOwners.delete(owner);
  // A sidebar destroyed mid-drag must not leave the row stuck in the dragging
  // state or the body stuck in reorder mode.
  if (activeDrag !== null && activeDrag.owner === owner) {
    activeDrag.sourceEl.classList.remove("dragging");
    document.body.classList.remove("channel-reordering");
    activeDrag.containerEl.querySelectorAll(".channel-drop-indicator").forEach((x) => {
      x.classList.remove("channel-drop-indicator");
    });
    activeDrag = null;
  }
  if (listenerOwners.size === 0 && globalDragAc !== null) {
    globalDragAc.abort();
    globalDragAc = null;
  }
}

/** A sidebar re-render replaces the channel rows mid-drag
 *  (ChannelSidebar.renderChannels() clears the list and rebuilds every
 *  group), leaving the captured container detached — and detached rows
 *  report all-zero rects, so no hit-test against them can succeed. Re-point
 *  the drag at the dragged channel's live row (found by its stamped id), its
 *  live container, and the store's current snapshot of that group, so the
 *  drop still resolves. Returns false when no live row exists (e.g. the
 *  channel was deleted or its category collapsed mid-drag). */
function retargetDetachedDrag(drag: DragState): boolean {
  if (drag.containerEl.isConnected) {
    return true;
  }
  const row = document.querySelector<HTMLElement>(`[data-drag-channel-id="${drag.channelId}"]`);
  const container = row?.closest<HTMLElement>(".category-channels-container") ?? null;
  if (row === null || container === null) {
    return false;
  }
  const byId = channelsStore.getState().channels;
  const channels: Channel[] = [];
  for (const item of container.querySelectorAll<HTMLElement>("[data-drag-channel-id]")) {
    const ch = byId.get(Number(item.dataset.dragChannelId));
    if (ch !== undefined) {
      channels.push(ch);
    }
  }
  drag.sourceEl.classList.remove("dragging");
  drag.sourceEl = row;
  drag.sourceEl.classList.add("dragging");
  drag.containerEl = container;
  drag.channels = channels;
  return true;
}

export function ensureGlobalDragListeners(owner: AbortSignal): void {
  if (owner.aborted || listenerOwners.has(owner)) {
    return;
  }
  listenerOwners.add(owner);
  owner.addEventListener("abort", () => releaseOwner(owner), { once: true });
  if (globalDragAc !== null) {
    return;
  }
  globalDragAc = new AbortController();

  document.addEventListener(
    "mousemove",
    (e) => {
      if (activeDrag === null) {
        return;
      }
      if (!retargetDetachedDrag(activeDrag)) {
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
    },
    { signal: globalDragAc.signal },
  );

  document.addEventListener(
    "mouseup",
    (e) => {
      if (activeDrag === null) {
        return;
      }
      const drag = activeDrag;
      activeDrag = null;

      // Re-target before cleanup so the classes are cleared from the live
      // rows, not a detached subtree.
      const retargeted = retargetDetachedDrag(drag);

      // Clean up visual state
      drag.sourceEl.classList.remove("dragging");
      document.body.classList.remove("channel-reordering");
      drag.containerEl.querySelectorAll(".channel-drop-indicator").forEach((x) => {
        x.classList.remove("channel-drop-indicator");
      });

      if (!retargeted) {
        return;
      }

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

      // Build reorder data and update store immediately. Reassign the
      // group's own existing position slots, not a 0..n-1 range: the
      // server's position space is global, so a category can sit at
      // non-contiguous positions (interleaved with other categories), and
      // renumbering from 0 would stomp another category's slots.
      const slots = drag.channels.map((c) => c.position).sort((a, b) => a - b);
      // The server does not enforce unique positions (newly created channels
      // commonly all sit at 0), and zipping tied slots onto the new order
      // would drop some or all of the moves. Nudge ties upward so every slot
      // is distinct; already-distinct groups keep their exact range.
      for (let i = 1; i < slots.length; i++) {
        const prev = slots[i - 1];
        const cur = slots[i];
        if (prev !== undefined && cur !== undefined && cur <= prev) {
          slots[i] = prev + 1;
        }
      }
      const reorders: ChannelReorderData[] = [];
      for (let i = 0; i < reorderedIds.length; i++) {
        const id = reorderedIds[i];
        const newPosition = slots[i];
        if (id === undefined || newPosition === undefined) {
          continue;
        }
        const ch = drag.channels.find((c) => c.id === id);
        if (ch !== undefined && ch.position !== newPosition) {
          reorders.push({ channelId: id, newPosition });
          updateChannelPosition(id, newPosition);
        }
      }

      if (reorders.length > 0) {
        drag.onReorder(reorders);
      }
    },
    { signal: globalDragAc.signal },
  );
}

/** Make a channel element draggable via mousedown (MANAGE_CHANNELS only). */
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
  // The one derivation for every channel-management affordance (create, edit,
  // delete, reorder) — a custom role holding the bit gets the same rows the
  // Edit/Delete menu already offers it, and a role merely *named* "admin"
  // without the bit does not get a drag the server will 403.
  if (!canManageChannels()) {
    return;
  }

  ensureGlobalDragListeners(signal);

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
      // Defuse a stale latch: pendingDrag is cleared only by a mouseup on
      // this same row (see the listener below), so releasing the button
      // anywhere else — off this row entirely, or via a fast flick — leaves
      // it armed. A later button-free hover would otherwise promote it into
      // a real drag on the next `if` below.
      if (e.buttons === 0) {
        pendingDrag = null;
        return;
      }
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
        owner: signal,
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
