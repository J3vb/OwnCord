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

import { Disposable } from "@lib/disposable";
import {
  categoryGroups,
  channelsStore,
  displayCategoryOf,
  nextPositionInCategory,
  updateChannel,
  updateChannelPosition,
  UNCATEGORIZED_VOICE_CATEGORY,
} from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import type { ChannelReorderData } from "../ChannelSidebar";
import { canManageChannels, visibleCategories } from "@lib/permissions";

const DROP_INDICATOR = "channel-drop-indicator";
const CATEGORY_BEFORE = "category-drop-before";
const CATEGORY_AFTER = "category-drop-after";
const CONTAINER_SELECTOR = ".category-channels-container";

// ── Drag state (mouse-based, avoids WebView2 HTML5 DnD issues) ──
interface ChannelDrag {
  kind: "channel";
  channelId: number;
  sourceEl: HTMLElement;
  containerEl: HTMLElement;
  channels: readonly Channel[];
  onReorder: (reorders: readonly ChannelReorderData[]) => void;
  /** The signal of the sidebar that started this drag, so its teardown can
   *  clear the in-flight visual state without touching another sidebar's. */
  owner: AbortSignal;
}
interface CategoryDrag {
  kind: "category";
  categoryId: number;
  /** The dragged category's header. */
  sourceEl: HTMLElement;
  onReorder: (categoryId: number, targetId: number, before: boolean) => void;
  owner: AbortSignal;
}
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

// ── Hit-testing ──────────────────────────────────────────────────────────

/** The category group a drop lands in, read from its header. The uncategorized
 *  text area has no header (`key` null); the synthetic Voice group has one but
 *  no id; a legacy name-only category has neither an id nor the Voice key. */
interface GroupInfo {
  readonly key: string | null;
  readonly categoryId: number;
  readonly name: string;
}

function groupOfHeader(header: HTMLElement | null): GroupInfo {
  if (header === null) {
    return { key: null, categoryId: 0, name: "" };
  }
  return {
    key: header.dataset.categoryKey ?? null,
    categoryId: Number(header.dataset.categoryId ?? 0),
    name: header.dataset.category ?? "",
  };
}

function groupOfContainer(container: HTMLElement): GroupInfo {
  return groupOfHeader(
    container.parentElement?.querySelector<HTMLElement>(":scope > .category") ?? null,
  );
}

type DropTarget =
  | {
      readonly kind: "row";
      readonly el: HTMLElement;
      readonly channelId: number;
      readonly before: boolean;
      readonly container: HTMLElement;
    }
  | { readonly kind: "header"; readonly el: HTMLElement; readonly group: GroupInfo };

/** Whether the pointer is over `el`. Rows and headers stack in one column, so
 *  the vertical test decides; the horizontal one only keeps a release in the
 *  chat area beside a row from counting as a drop on it. */
function pointerOver(el: Element, e: MouseEvent): boolean {
  const rect = el.getBoundingClientRect();
  if (e.clientY < rect.top || e.clientY > rect.bottom) {
    return false;
  }
  return rect.width === 0 || (e.clientX >= rect.left && e.clientX <= rect.right);
}

function sidebarRoot(from: HTMLElement): ParentNode {
  return from.closest(".channel-list") ?? document;
}

/** What the pointer is over: a row of the drag's own container first (the
 *  within-category drop), then a row of any other category, then a category
 *  header, whose drop appends to its category. */
function findDropTarget(drag: ChannelDrag, e: MouseEvent): DropTarget | null {
  const rowAt = (item: HTMLElement, container: HTMLElement): DropTarget | null => {
    const rect = item.getBoundingClientRect();
    return pointerOver(item, e)
      ? {
          kind: "row",
          el: item,
          channelId: Number(item.dataset.dragChannelId),
          before: e.clientY < rect.top + rect.height / 2,
          container,
        }
      : null;
  };
  for (const item of drag.containerEl.querySelectorAll<HTMLElement>("[data-drag-channel-id]")) {
    const hit = rowAt(item, drag.containerEl);
    if (hit !== null) {
      return hit;
    }
  }
  const root = sidebarRoot(drag.containerEl);
  for (const item of root.querySelectorAll<HTMLElement>("[data-drag-channel-id]")) {
    const container = item.closest<HTMLElement>(CONTAINER_SELECTOR);
    if (container === null || container === drag.containerEl) {
      continue;
    }
    const hit = rowAt(item, container);
    if (hit !== null) {
      return hit;
    }
  }
  for (const header of root.querySelectorAll<HTMLElement>(".category")) {
    if (pointerOver(header, e)) {
      return { kind: "header", el: header, group: groupOfHeader(header) };
    }
  }
  return null;
}

// ── Channel drop planning ────────────────────────────────────────────────

/** Slots to reassign to a group: its own positions, ascending, with ties
 *  nudged upward. The server does not enforce unique positions (newly created
 *  channels commonly all sit at 0), and zipping tied slots onto the new order
 *  would drop some or all of the moves. Already-distinct groups keep their
 *  exact range. */
function slotsOf(positions: readonly number[]): number[] {
  const slots = positions.toSorted((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1];
    const cur = slots[i];
    if (prev !== undefined && cur !== undefined && cur <= prev) {
      slots[i] = prev + 1;
    }
  }
  return slots;
}

/** The group a drop files the dragged channel under, as the store keys it: a
 *  real category by its key, otherwise the uncategorized text group or the
 *  synthetic Voice group by the channel's kind. Null when the drop is refused:
 *  a text channel dropped on the Voice group, or a legacy name-only category
 *  (it has no id to file under). */
function destinationKey(dragged: Channel, group: GroupInfo): string | null | undefined {
  const isVoice = dragged.type === "voice";
  if (group.categoryId > 0) {
    return group.key;
  }
  if (group.key === null) {
    return isVoice ? UNCATEGORIZED_VOICE_CATEGORY : null;
  }
  if (group.key === UNCATEGORIZED_VOICE_CATEGORY) {
    return isVoice ? UNCATEGORIZED_VOICE_CATEGORY : undefined;
  }
  return undefined;
}

/** Reassign `slots` to `orderedIds` and report what changed. The moved channel
 *  (`moved`) is always reported, carrying the category change if there is one. */
function reslot(
  byId: ReadonlyMap<number, Channel>,
  orderedIds: readonly number[],
  slots: readonly number[],
  moved: { id: number; category?: ChannelReorderData["category"] } | null,
): ChannelReorderData[] {
  const reorders: ChannelReorderData[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i];
    const newPosition = slots[i];
    if (id === undefined || newPosition === undefined) {
      continue;
    }
    const ch = byId.get(id);
    if (ch === undefined) {
      continue;
    }
    const isMoved = moved !== null && moved.id === id;
    if (ch.position === newPosition && !(isMoved && moved.category !== undefined)) {
      continue;
    }
    reorders.push({
      channelId: id,
      newPosition,
      previousPosition: ch.position,
      ...(isMoved && moved.category !== undefined ? { category: moved.category } : {}),
    });
  }
  return reorders;
}

/** Whether the drop is refused outright: a channel dropped on a row of the
 *  other kind in its own category, or on a group it cannot be filed under. */
function dropRefused(drag: ChannelDrag, target: DropTarget): boolean {
  const dragged = drag.channels.find((c) => c.id === drag.channelId);
  if (dragged === undefined) {
    return false;
  }
  if (target.kind === "row" && target.container === drag.containerEl) {
    // Text rows always sit above voice rows, so a drop across that line
    // would renumber positions without moving anything on screen.
    const row = drag.channels.find((c) => c.id === target.channelId);
    return row !== undefined && (dragged.type === "voice") !== (row.type === "voice");
  }
  const group = target.kind === "row" ? groupOfContainer(target.container) : target.group;
  return destinationKey(dragged, group) === undefined;
}

/** The reorders a drop produces; empty when nothing would move. */
function planDrop(drag: ChannelDrag, target: DropTarget): ChannelReorderData[] {
  const dragged = drag.channels.find((c) => c.id === drag.channelId);
  if (dragged === undefined || dropRefused(drag, target)) {
    return [];
  }
  const sameContainerRow = target.kind === "row" && target.container === drag.containerEl;
  if (sameContainerRow) {
    if (target.channelId === drag.channelId) {
      return [];
    }
    const orderedIds = drag.channels.map((ch) => ch.id);
    const withoutDrag = orderedIds.filter((id) => id !== drag.channelId);
    const targetIdx = withoutDrag.indexOf(target.channelId);
    if (targetIdx === -1) {
      return [];
    }
    const insertIdx = target.before ? targetIdx : targetIdx + 1;
    const reorderedIds = [
      ...withoutDrag.slice(0, insertIdx),
      drag.channelId,
      ...withoutDrag.slice(insertIdx),
    ];
    // Reassign the group's own existing position slots, not a 0..n-1 range:
    // the server's position space is global, so a category can sit at
    // non-contiguous positions (interleaved with other categories), and
    // renumbering from 0 would stomp another category's slots.
    const slots = slotsOf(drag.channels.map((c) => c.position));
    return reslot(new Map(drag.channels.map((c) => [c.id, c])), reorderedIds, slots, null);
  }

  // A drop on a row of another category, on any header, or on the area of the
  // group the channel already sits in: file the channel under the destination
  // group, at the row's place or at the end of its kind.
  const group = target.kind === "row" ? groupOfContainer(target.container) : target.group;
  const destKey = destinationKey(dragged, group);
  if (destKey === undefined) {
    return [];
  }
  const state = channelsStore.getState();
  const current = state.channels.get(dragged.id) ?? dragged;
  const sourceKey = displayCategoryOf(current);
  const inPlace = destKey === sourceKey;
  const peers =
    categoryGroups(state.channels, visibleCategories()).find((g) => g.key === destKey)?.channels ??
    [];
  const others = peers.filter((c) => c.id !== current.id);
  const ids = others.map((c) => c.id);
  // Text rows come first, so the first voice row's index is where the kinds meet.
  const boundary = others.filter((c) => c.type !== "voice").length;
  const isVoice = current.type === "voice";
  let insertIdx = isVoice ? ids.length : boundary;
  if (target.kind === "row") {
    const at = others.findIndex((c) => c.id === target.channelId);
    const row = at === -1 ? undefined : others[at];
    if (row !== undefined && (row.type === "voice") === isVoice) {
      insertIdx = target.before ? at : at + 1;
    } else if (isVoice) {
      insertIdx = boundary;
    }
  }
  const orderedIds = [...ids.slice(0, insertIdx), current.id, ...ids.slice(insertIdx)];
  const positions = peers.map((c) => c.position);
  if (!inPlace) {
    // The channel needs a slot of its own at the end of the group's range.
    positions.push(
      peers.length === 0
        ? nextPositionInCategory(group.categoryId, current.type)
        : Math.max(...positions) + 1,
    );
  }
  const slots = slotsOf(positions);
  const byId = new Map(peers.map((c) => [c.id, c]));
  byId.set(current.id, current);
  let category: ChannelReorderData["category"];
  if (!inPlace) {
    const categoryId =
      destKey === null || destKey === UNCATEGORIZED_VOICE_CATEGORY ? 0 : group.categoryId;
    const listed = visibleCategories().find((c) => c.id === categoryId);
    category = {
      previous: {
        categoryId: current.categoryId,
        category: current.category,
        categoryPosition: current.categoryPosition,
      },
      next: {
        categoryId,
        category: categoryId > 0 ? group.name : "",
        categoryPosition:
          categoryId > 0 ? (listed?.position ?? peers[0]?.categoryPosition ?? 0) : 0,
      },
    };
  }
  return reslot(byId, orderedIds, slots, { id: current.id, ...(category ? { category } : {}) });
}

/** Apply a plan to the store at once: the optimistic move. */
function applyOptimistic(reorders: readonly ChannelReorderData[]): void {
  for (const r of reorders) {
    if (r.category === undefined) {
      updateChannelPosition(r.channelId, r.newPosition);
      continue;
    }
    const next = r.category.next;
    updateChannel({
      id: r.channelId,
      position: r.newPosition,
      category_id: next.categoryId ?? 0,
      category: next.category ?? "",
      category_position: next.categoryPosition ?? 0,
    });
  }
}

// ── Category drop planning ───────────────────────────────────────────────

interface CategoryDropTarget {
  readonly group: HTMLElement;
  readonly targetId: number;
  readonly before: boolean;
}

/** The real category (id > 0, not the dragged one) the pointer is over: its
 *  header or any of its rows. Over the header's upper half the drop goes
 *  before it, anywhere else in the group after it. */
function findCategoryTarget(drag: CategoryDrag, e: MouseEvent): CategoryDropTarget | null {
  for (const header of sidebarRoot(drag.sourceEl).querySelectorAll<HTMLElement>(
    ".category[data-category-id]",
  )) {
    const targetId = Number(header.dataset.categoryId);
    const group = header.parentElement;
    if (!(targetId > 0) || targetId === drag.categoryId || group === null) {
      continue;
    }
    if (!pointerOver(group, e)) {
      continue;
    }
    const rect = header.getBoundingClientRect();
    return {
      group,
      targetId,
      before: e.clientY <= rect.bottom && e.clientY < rect.top + rect.height / 2,
    };
  }
  return null;
}

// ── Shared document listeners ────────────────────────────────────────────

function onDocumentMouseMove(e: MouseEvent): void {
  const drag = activeDrag;
  if (drag === null) {
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
