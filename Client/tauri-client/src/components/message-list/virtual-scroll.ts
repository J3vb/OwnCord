/**
 * Virtual scroll manager — manages height estimation, Fenwick-tree-backed
 * offset calculations, and spacer management for DOM windowing.
 */

import { FenwickTree } from "./fenwick";

export interface VirtualScrollItem {
  readonly kind: string;
}

export interface VirtualScrollOptions {
  /** Number of items to render beyond visible viewport in each direction. */
  readonly overscan: number;
  /** Estimate height for an item at given index. */
  readonly estimateHeight: (index: number) => number;
  /** Generate a stable cache key for an item at given index. */
  readonly itemKey: (index: number) => string;
}

export interface VisibleRange {
  readonly start: number;
  readonly end: number;
}

export class VirtualScrollManager {
  private readonly heightCache = new Map<string, number>();
  private tree: FenwickTree | null = null;
  private itemCount = 0;
  private readonly opts: VirtualScrollOptions;

  constructor(opts: VirtualScrollOptions) {
    this.opts = opts;
  }

  /** Rebuild the Fenwick tree for a new item count, preserving cached heights. */
  rebuild(count: number): void {
    this.itemCount = count;
    this.tree = new FenwickTree(count);
    for (let i = 0; i < count; i++) {
      const key = this.opts.itemKey(i);
      const cached = this.heightCache.get(key);
      const h = cached !== undefined ? cached : this.opts.estimateHeight(i);
      this.tree.set(i, h);
    }
  }

  /** Get height for item at index (cached or estimated). */
  getHeight(index: number): number {
    const cached = this.heightCache.get(this.opts.itemKey(index));
    if (cached !== undefined) return cached;
    return this.opts.estimateHeight(index);
  }

  /** Cache a measured height for an item. */
  setMeasured(index: number, height: number): void {
    if (height <= 0) return;
    const key = this.opts.itemKey(index);
    this.heightCache.set(key, height);
    if (this.tree !== null && index < this.tree.size) {
      this.tree.set(index, height);
    }
  }

  /** Total estimated height of all items. */
  totalHeight(): number {
    if (this.tree !== null) return this.tree.total();
    let h = 0;
    for (let i = 0; i < this.itemCount; i++) {
      h += this.getHeight(i);
    }
    return h;
  }

  /** Sum of heights for items [0, index). */
  offsetBefore(index: number): number {
    if (this.tree !== null && index > 0) return this.tree.prefixSum(index - 1);
    if (this.tree !== null && index <= 0) return 0;
    let offset = 0;
    for (let i = 0; i < index && i < this.itemCount; i++) {
      offset += this.getHeight(i);
    }
    return offset;
  }

  /** Find the item index at a given scroll offset. */
  offsetToIndex(scrollTop: number): number {
    if (this.tree !== null) return this.tree.findIndex(scrollTop);
    let offset = 0;
    for (let i = 0; i < this.itemCount; i++) {
      const h = this.getHeight(i);
      if (offset + h > scrollTop) return i;
      offset += h;
    }
    return Math.max(0, this.itemCount - 1);
  }

  /** Compute the visible range with overscan. */
  visibleRange(scrollTop: number, clientHeight: number): VisibleRange {
    const firstVisible = this.offsetToIndex(scrollTop);
    const lastVisible = this.offsetToIndex(scrollTop + clientHeight);
    return {
      start: Math.max(0, firstVisible - this.opts.overscan),
      end: Math.min(this.itemCount, lastVisible + this.opts.overscan + 1),
    };
  }

  /** Compute spacer heights for a rendered range. */
  spacerHeights(start: number, end: number): { top: number; bottom: number } {
    const top = this.offsetBefore(start);
    let bottom: number;
    if (this.tree !== null) {
      const totalH = this.tree.total();
      const endOffset = end > 0 ? this.tree.prefixSum(end - 1) : 0;
      bottom = totalH - endOffset;
    } else {
      bottom = 0;
      for (let i = end; i < this.itemCount; i++) {
        bottom += this.getHeight(i);
      }
    }
    return { top, bottom };
  }

  /** Clear all cached heights. */
  clear(): void {
    this.heightCache.clear();
    this.tree = null;
    this.itemCount = 0;
  }

  get size(): number {
    return this.itemCount;
  }

  get treeSize(): number {
    return this.tree?.size ?? 0;
  }
}
