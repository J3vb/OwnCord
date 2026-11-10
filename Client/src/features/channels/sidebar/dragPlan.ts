/**
 * Channel drag-reorder planning: the reorders a drop produces and the
 * optimistic store move that applies them. Pure over the drag and the drop
 * target plus the channel store's current snapshot; the DOM work is
 * `dragHitTest.ts`, the in-flight drag `dragReorder.ts`. A failed save is
 * rolled back by `channelReorderRollback.ts`, from the `previousPosition` and
 * `category` this plan records.
 */

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
import { visibleCategories } from "@lib/permissions";
import type { ChannelReorderData } from "../channelSidebarTypes";
import { groupOfContainer, type ChannelDrag, type DropTarget, type GroupInfo } from "./dragHitTest";

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
export function dropRefused(drag: ChannelDrag, target: DropTarget): boolean {
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

/** A drop on a row of the channel's own group: reorder within it. */
function planWithinGroup(
  drag: ChannelDrag,
  target: Extract<DropTarget, { kind: "row" }>,
): ChannelReorderData[] {
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

/** Where the dragged channel goes among the destination's other channels:
 *  at the hovered row's place when it is of its kind, else at the end of its kind. */
function insertIndexIn(others: readonly Channel[], current: Channel, target: DropTarget): number {
  // Text rows come first, so the first voice row's index is where the kinds meet.
  const boundary = others.filter((c) => c.type !== "voice").length;
  const isVoice = current.type === "voice";
  let insertIdx = isVoice ? others.length : boundary;
  if (target.kind === "row") {
    const at = others.findIndex((c) => c.id === target.channelId);
    const row = at === -1 ? undefined : others[at];
    if (row !== undefined && (row.type === "voice") === isVoice) {
      insertIdx = target.before ? at : at + 1;
    } else if (isVoice) {
      insertIdx = boundary;
    }
  }
  return insertIdx;
}

/** The category change a cross-group drop carries, so the PATCH and a rollback both have it. */
function categoryChangeOf(
  current: Channel,
  destKey: string | null,
  group: GroupInfo,
  peers: readonly Channel[],
): NonNullable<ChannelReorderData["category"]> {
  const categoryId =
    destKey === null || destKey === UNCATEGORIZED_VOICE_CATEGORY ? 0 : group.categoryId;
  const listed = visibleCategories().find((c) => c.id === categoryId);
  return {
    previous: {
      categoryId: current.categoryId,
      category: current.category,
      categoryPosition: current.categoryPosition,
    },
    next: {
      categoryId,
      category: categoryId > 0 ? group.name : "",
      categoryPosition: categoryId > 0 ? (listed?.position ?? peers[0]?.categoryPosition ?? 0) : 0,
    },
  };
}

/** A drop on a row of another category, on any header, or on the area of the
 *  group the channel already sits in: file the channel under the destination
 *  group, at the row's place or at the end of its kind. */
function planIntoGroup(
  dragged: Channel,
  target: DropTarget,
  group: GroupInfo,
  destKey: string | null,
): ChannelReorderData[] {
  const state = channelsStore.getState();
  const current = state.channels.get(dragged.id) ?? dragged;
  const inPlace = destKey === displayCategoryOf(current);
  const peers =
    categoryGroups(state.channels, visibleCategories()).find((g) => g.key === destKey)?.channels ??
    [];
  const others = peers.filter((c) => c.id !== current.id);
  const ids = others.map((c) => c.id);
  const insertIdx = insertIndexIn(others, current, target);
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
  const category = inPlace ? undefined : categoryChangeOf(current, destKey, group, peers);
  return reslot(byId, orderedIds, slots, { id: current.id, ...(category ? { category } : {}) });
}

/** The reorders a drop produces; empty when nothing would move. */
export function planDrop(drag: ChannelDrag, target: DropTarget): ChannelReorderData[] {
  const dragged = drag.channels.find((c) => c.id === drag.channelId);
  if (dragged === undefined || dropRefused(drag, target)) {
    return [];
  }
  if (target.kind === "row" && target.container === drag.containerEl) {
    return planWithinGroup(drag, target);
  }
  const group = target.kind === "row" ? groupOfContainer(target.container) : target.group;
  const destKey = destinationKey(dragged, group);
  if (destKey === undefined) {
    return [];
  }
  return planIntoGroup(dragged, target, group, destKey);
}

/** Apply a plan to the store at once: the optimistic move. */
export function applyOptimistic(reorders: readonly ChannelReorderData[]): void {
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
