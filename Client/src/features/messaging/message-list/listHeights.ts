/**
 * The message list's row heights: the measured-or-estimated height of every
 * item, and the Fenwick tree that turns them into offsets.
 */
import { estimateItemHeight, keyOf } from "./virtualItems";
import { FenwickTree } from "./fenwick";
import { rememberedRowHeight, rowHeightKey } from "./rowHeights";
import type { ListState } from "./listState";

export function createListHeights(st: ListState) {
  function itemKey(index: number): string {
    return keyOf(st.virtualItems[index], index);
  }

  function getItemHeight(index: number): number {
    const cached = st.heightCache.get(itemKey(index));
    if (cached !== undefined) return cached;
    return estimateRow(index);
  }

  /** A message row's height key across lists; null for rows that are not a
   *  confirmed message. */
  function rememberKey(index: number): string | null {
    const item = st.virtualItems[index];
    if (item === undefined || item.kind !== "message" || item.message.id === 0) return null;
    return rowHeightKey(item.message.id, item.isGrouped, item.message.editedAt);
  }

  /** An unmeasured row: the height an earlier list of this channel drew it at,
   *  else the estimate. */
  function estimateRow(index: number): number {
    const key = st.estimateWidth === undefined ? null : rememberKey(index);
    const remembered = key === null ? undefined : rememberedRowHeight(key, st.estimateWidth!);
    return remembered ?? estimateItemHeight(st.virtualItems[index]!, st.estimateWidth);
  }

  function totalHeight(): number {
    if (st.tree !== null) return st.tree.total();
    let h = 0;
    for (let i = 0; i < st.virtualItems.length; i++) {
      h += getItemHeight(i);
    }
    return h;
  }

  function offsetToIndex(scrollTop: number): number {
    if (st.tree !== null) return st.tree.findIndex(scrollTop);
    let offset = 0;
    for (let i = 0; i < st.virtualItems.length; i++) {
      const h = getItemHeight(i);
      if (offset + h > scrollTop) return i;
      offset += h;
    }
    return st.virtualItems.length - 1;
  }

  function offsetBefore(index: number): number {
    if (st.tree !== null && index > 0) return st.tree.prefixSum(index - 1);
    if (st.tree !== null && index <= 0) return 0;
    let offset = 0;
    for (let i = 0; i < index && i < st.virtualItems.length; i++) {
      offset += getItemHeight(i);
    }
    return offset;
  }

  /** Estimate again every row that has no measured height, leaving measured
   *  rows (and so the rendered window) as they are. */
  function reseedUnmeasured(): void {
    if (st.tree === null) return;
    for (let i = 0; i < st.virtualItems.length; i++) {
      if (!st.heightCache.has(itemKey(i))) st.tree.set(i, estimateRow(i));
    }
  }

  /** Build the Fenwick tree from measured heights, estimating the rest. */
  function seedTree(): void {
    st.tree = new FenwickTree(st.virtualItems.length);
    for (let i = 0; i < st.virtualItems.length; i++) st.tree.set(i, getItemHeight(i));
  }

  return {
    itemKey,
    getItemHeight,
    rememberKey,
    estimateRow,
    totalHeight,
    offsetToIndex,
    offsetBefore,
    reseedUnmeasured,
    seedTree,
  };
}
