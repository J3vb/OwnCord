/**
 * Channel drag-reorder — mouse-based drag-and-drop for channel reordering.
 * Uses mousedown/mousemove/mouseup (avoids WebView2 HTML5 DnD issues).
 * Gated on MANAGE_CHANNELS, like every other channel-management affordance.
 *
 * Two gestures share the one in-flight drag and the one pair of document
 * listeners:
 *  - a channel row dragged within its category, onto a row or the header of
 *    another category, or into the uncategorized area (moves the channel);
 *  - a real category's header dragged onto another category (reorders them).
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { channelsStore } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import type { ChannelReorderData } from "../channelSidebarTypes";
import { canManageChannels } from "@lib/permissions";
import {
  CONTAINER_SELECTOR,
  findCategoryTarget,
  findDropTarget,
  type CategoryDrag,
  type ChannelDrag,
} from "./dragHitTest";
import { applyOptimistic, dropRefused, planDrop } from "./dragPlan";

const DROP_INDICATOR = "channel-drop-indicator";
const CATEGORY_BEFORE = "category-drop-before";
const CATEGORY_AFTER = "category-drop-after";

// ── Drag state (mouse-based, avoids WebView2 HTML5 DnD issues) ──
type DragState = ChannelDrag | CategoryDrag;
let activeDrag: DragState | null = null;
/** When the last category drag ended; the header's click that follows the
 *  release (it lands on the header the press began on) must not collapse it. */
let lastCategoryDragEnd = 0;

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
let globalDragOwner: Disposable | null = null;

/** Drop every drop indicator, whichever container or header holds it. */
function clearIndicators(): void {
  document
    .querySelectorAll(`.${DROP_INDICATOR}, .${CATEGORY_BEFORE}, .${CATEGORY_AFTER}`)
    .forEach((x) => {
      x.classList.remove(DROP_INDICATOR, CATEGORY_BEFORE, CATEGORY_AFTER);
    });
}

function releaseOwner(owner: AbortSignal): void {
  listenerOwners.delete(owner);
  // A sidebar destroyed mid-drag must not leave the row stuck in the dragging
  // state or the body stuck in reorder mode.
  if (activeDrag !== null && activeDrag.owner === owner) {
    activeDrag.sourceEl.classList.remove("dragging");
    document.body.classList.remove("channel-reordering");
    clearIndicators();
    activeDrag = null;
  }
  if (listenerOwners.size === 0 && globalDragOwner !== null) {
    globalDragOwner.destroy();
    globalDragOwner = null;
  }
}

/** A sidebar re-render replaces the channel rows mid-drag
 *  (ChannelSidebar.renderChannels() clears the list and rebuilds every
 *  group), leaving the captured container detached — and detached rows
 *  report all-zero rects, so no hit-test against them can succeed. Re-point
 *  the drag at the dragged channel's live row (found by its stamped id), its
 *  live container, and the store's current snapshot of that group, so the
 *  drop still resolves. Returns false when no live row exists (e.g. the
 *  channel was deleted or its category collapsed mid-drag). The drop target
 *  is hit-tested against the live document afresh on every event, so a target
 *  in another container needs no re-pointing. */
function retargetDetachedDrag(drag: ChannelDrag): boolean {
  if (drag.containerEl.isConnected) {
    return true;
  }
  const row = document.querySelector<HTMLElement>(`[data-drag-channel-id="${drag.channelId}"]`);
  const container = row?.closest<HTMLElement>(CONTAINER_SELECTOR) ?? null;
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

/** The dragged category's live header, re-found after a re-render replaced it;
 *  false when the category is gone (deleted mid-drag). */
function retargetCategoryDrag(drag: CategoryDrag): boolean {
  if (drag.sourceEl.isConnected) {
    return true;
  }
  const header = document.querySelector<HTMLElement>(
    `.category[data-category-id="${drag.categoryId}"]`,
  );
  if (header === null) {
    return false;
  }
  drag.sourceEl = header;
  header.classList.add("dragging");
  return true;
}

// ── Shared document listeners ────────────────────────────────────────────

/** Abandon the in-flight drag without dropping: the release never reached the
 *  page (focus moved to another window mid-drag), or the user pressed Escape. */
function cancelActiveDrag(): void {
  const drag = activeDrag;
  if (drag === null) {
    return;
  }
  activeDrag = null;
  drag.sourceEl.classList.remove("dragging");
  document.body.classList.remove("channel-reordering");
  clearIndicators();
  if (drag.kind === "category") {
    lastCategoryDragEnd = Date.now();
  }
}

function onDocumentKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && !isImeCommit(e)) {
    cancelActiveDrag();
  }
}

function onDocumentMouseMove(e: MouseEvent): void {
  const drag = activeDrag;
  if (drag === null) {
    return;
  }
  // A move with no button down means the release was lost.
  if (e.buttons === 0) {
    cancelActiveDrag();
    return;
  }
  if (drag.kind === "category") {
    if (!retargetCategoryDrag(drag)) {
      return;
    }
    clearIndicators();
    const target = canManageChannels() ? findCategoryTarget(drag, e) : null;
    target?.group.classList.add(target.before ? CATEGORY_BEFORE : CATEGORY_AFTER);
    return;
  }
  if (!retargetDetachedDrag(drag)) {
    return;
  }
  clearIndicators();
  const target = findDropTarget(drag, e);
  if (target === null || dropRefused(drag, target)) {
    return;
  }
  if (target.kind === "row" && target.channelId === drag.channelId) {
    return;
  }
  target.el.classList.add(DROP_INDICATOR);
}

function onDocumentMouseUp(e: MouseEvent): void {
  const drag = activeDrag;
  if (drag === null) {
    return;
  }
  activeDrag = null;
  if (drag.kind === "category") {
    finishCategoryDrag(drag, e);
    return;
  }

  // Re-target before cleanup so the classes are cleared from the live
  // rows, not a detached subtree.
  const retargeted = retargetDetachedDrag(drag);

  // Clean up visual state
  drag.sourceEl.classList.remove("dragging");
  document.body.classList.remove("channel-reordering");
  clearIndicators();

  if (!retargeted) {
    return;
  }
  // As for a category drop, the permission is read again on release: a demotion
  // mid-drag drops the move before it touches the store or the API.
  if (!canManageChannels()) {
    return;
  }

  const target = findDropTarget(drag, e);
  if (target === null || (target.kind === "row" && target.channelId === drag.channelId)) {
    return;
  }
  const reorders = planDrop(drag, target);
  if (reorders.length === 0) {
    return;
  }
  applyOptimistic(reorders);
  drag.onReorder(reorders);
}

function finishCategoryDrag(drag: CategoryDrag, e: MouseEvent): void {
  const live = retargetCategoryDrag(drag);
  drag.sourceEl.classList.remove("dragging");
  document.body.classList.remove("channel-reordering");
  clearIndicators();
  lastCategoryDragEnd = Date.now();
  // The permission is read again on release: a demotion mid-drag drops it.
  if (!live || !canManageChannels()) {
    return;
  }
  const target = findCategoryTarget(drag, e);
  if (target !== null) {
    drag.onReorder(drag.categoryId, target.targetId, target.before);
  }
}

export function ensureGlobalDragListeners(owner: AbortSignal): void {
  if (owner.aborted || listenerOwners.has(owner)) {
    return;
  }
  listenerOwners.add(owner);
  owner.addEventListener("abort", () => releaseOwner(owner), { once: true });
  if (globalDragOwner !== null) {
    return;
  }
  globalDragOwner = new Disposable();
  document.addEventListener("mousemove", onDocumentMouseMove, { signal: globalDragOwner.signal });
  document.addEventListener("mouseup", onDocumentMouseUp, { signal: globalDragOwner.signal });
  document.addEventListener("keydown", onDocumentKeyDown, { signal: globalDragOwner.signal });
  window.addEventListener("blur", cancelActiveDrag, { signal: globalDragOwner.signal });
}

/** Make a channel element draggable via mousedown (MANAGE_CHANNELS only).
 *  `signal` is per-render — it is aborted and replaced on every sidebar
 *  re-render, so it scopes only this row's own mousedown/mousemove/mouseup
 *  listeners (a stale row must not outlive the render that replaced
 *  it). `lifetimeSignal` is the sidebar's lifetime controller and is what
 *  owns the shared document-level drag listeners (see the module comment on
 *  `listenerOwners`): a mid-drag re-render must not tear those down or
 *  cancel the in-flight drag, or `retargetDetachedDrag` never gets a chance
 *  to run. */
export function attachDragHandlers(
  el: HTMLElement,
  channel: Channel,
  containerEl: HTMLElement,
  channels: readonly Channel[],
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
  onReorderChannel?: (reorders: readonly ChannelReorderData[]) => void,
  /** The caller's answer to "may this user manage channels"; omitted, it is
   *  read from the stores here. */
  canManage?: boolean,
): void {
  if (onReorderChannel === undefined) {
    return;
  }
  // The one derivation for every channel-management affordance (create, edit,
  // delete, reorder) — a custom role holding the bit gets the same rows the
  // Edit/Delete menu already offers it, and a role merely *named* "admin"
  // without the bit does not get a drag the server will 403.
  if (!(canManage ?? canManageChannels())) {
    return;
  }

  ensureGlobalDragListeners(lifetimeSignal);

  el.classList.add("channel-draggable");
  el.dataset.dragChannelId = String(channel.id);

  let pendingDrag: { startX: number; startY: number } | null = null;

  el.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) {
        return;
      }
      // A press on a voice participant is features/voice/dragMove's gesture.
      if (e.target instanceof Element && e.target.closest(".voice-user-item") !== null) {
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
        kind: "channel",
        channelId: channel.id,
        sourceEl: el,
        containerEl,
        channels,
        onReorder: onReorderChannel,
        owner: lifetimeSignal,
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

/** Make a real category's header draggable to reorder the categories
 *  (MANAGE_CHANNELS only). Only a category with an id can be dragged:
 *  the uncategorized area, the synthetic Voice group and a legacy name-only
 *  category have no place in the order. A press on the header's arrow or "+"
 *  stays a click. The drop calls `onReorderCategory` and changes nothing
 *  locally: the `channel_categories` frame the server answers with applies the
 *  new order. `signal` is per-render, `lifetimeSignal` the sidebar's (see
 *  {@link attachDragHandlers}). */
export function attachCategoryDragHandlers(
  header: HTMLElement,
  categoryId: number,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
  onReorderCategory?: (categoryId: number, targetId: number, before: boolean) => void,
  canManage?: boolean,
): void {
  if (onReorderCategory === undefined || !(categoryId > 0) || !(canManage ?? canManageChannels())) {
    return;
  }

  ensureGlobalDragListeners(lifetimeSignal);

  header.classList.add("category-draggable");

  let pendingDrag: { startX: number; startY: number } | null = null;

  header.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) {
        return;
      }
      if (e.target instanceof Element && e.target.closest("button") !== null) {
        return;
      }
      pendingDrag = { startX: e.clientX, startY: e.clientY };
    },
    { signal },
  );

  header.addEventListener(
    "mousemove",
    (e) => {
      if (e.buttons === 0) {
        pendingDrag = null;
        return;
      }
      if (pendingDrag === null || activeDrag !== null) {
        return;
      }
      const dx = Math.abs(e.clientX - pendingDrag.startX);
      const dy = Math.abs(e.clientY - pendingDrag.startY);
      if (dx + dy < 5) {
        return;
      }
      pendingDrag = null;
      // The role can change between render and press.
      if (!canManageChannels()) {
        return;
      }
      activeDrag = {
        kind: "category",
        categoryId,
        sourceEl: header,
        onReorder: onReorderCategory,
        owner: lifetimeSignal,
      };
      header.classList.add("dragging");
      document.body.classList.add("channel-reordering");
    },
    { signal },
  );

  header.addEventListener(
    "mouseup",
    () => {
      pendingDrag = null;
    },
    { signal },
  );

  // Capture phase, so it runs before the header's own collapse toggle.
  header.addEventListener(
    "click",
    (e) => {
      if (Date.now() - lastCategoryDragEnd < 100) {
        e.stopImmediatePropagation();
      }
    },
    { signal, capture: true },
  );
}
