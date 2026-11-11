/**
 * Channel drag-reorder hit-testing: what the pointer is over while a channel
 * row or a category header is dragged. It reads the live DOM afresh on every
 * call and holds no state; `dragReorder.ts` owns the in-flight drag and
 * `dragPlan.ts` turns a target into reorders.
 */

import type { Channel } from "@stores/channels.store";
import type { ChannelReorderData } from "../channelSidebarTypes";

export const CONTAINER_SELECTOR = ".category-channels-container";

export interface ChannelDrag {
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

export interface CategoryDrag {
  kind: "category";
  categoryId: number;
  /** The dragged category's header. */
  sourceEl: HTMLElement;
  onReorder: (categoryId: number, targetId: number, before: boolean) => void;
  owner: AbortSignal;
}

/** The category group a drop lands in, read from its header. The uncategorized
 *  text area has no header (`key` null); the synthetic Voice group has one but
 *  no id; a legacy name-only category has neither an id nor the Voice key. */
export interface GroupInfo {
  readonly key: string | null;
  readonly categoryId: number;
  readonly name: string;
}

export function groupOfHeader(header: HTMLElement | null): GroupInfo {
  if (header === null) {
    return { key: null, categoryId: 0, name: "" };
  }
  return {
    key: header.dataset.categoryKey ?? null,
    categoryId: Number(header.dataset.categoryId ?? 0),
    name: header.dataset.category ?? "",
  };
}

export function groupOfContainer(container: HTMLElement): GroupInfo {
  return groupOfHeader(
    container.parentElement?.querySelector<HTMLElement>(":scope > .category") ?? null,
  );
}

export type DropTarget =
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

export function sidebarRoot(from: HTMLElement): ParentNode {
  return from.closest(".channel-list") ?? document;
}

/** What the pointer is over: a row of the drag's own container first (the
 *  within-category drop), then a row of any other category, then a category
 *  header, whose drop appends to its category. */
export function findDropTarget(drag: ChannelDrag, e: MouseEvent): DropTarget | null {
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

export interface CategoryDropTarget {
  readonly group: HTMLElement;
  readonly targetId: number;
  readonly before: boolean;
}

/** The real category (id > 0, not the dragged one) the pointer is over: its
 *  header or any of its rows. Over the header's upper half the drop goes
 *  before it, anywhere else in the group after it. */
export function findCategoryTarget(drag: CategoryDrag, e: MouseEvent): CategoryDropTarget | null {
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
