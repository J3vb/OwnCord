/**
 * Fenwick Tree (Binary Indexed Tree) for O(log n) prefix sums and updates.
 * Used by the virtual scroll to efficiently compute item offsets.
 */
export class FenwickTree {
  private readonly tree: Float64Array;
  private readonly values: Float64Array;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.tree = new Float64Array(size + 1);
    this.values = new Float64Array(size);
  }

  /** Set value at index and update tree. */
  set(i: number, value: number): void {
    const prev = this.values[i] as number;
    const delta = value - prev;
    if (delta === 0) return;
    this.values[i] = value;
    for (let x = i + 1; x <= this.size; x += x & (-x)) {
      (this.tree as Float64Array)[x] = (this.tree[x] as number) + delta;
    }
  }

  /** Get value at index. */
  get(i: number): number {
    return this.values[i] as number;
  }

  /** Prefix sum of [0..i] inclusive. */
  prefixSum(i: number): number {
    if (i < 0) return 0;
    let s = 0;
    for (let x = i + 1; x > 0; x -= x & (-x)) {
      s += this.tree[x] as number;
    }
    return s;
  }

  /** Total sum of all values. */
  total(): number {
    return this.prefixSum(this.size - 1);
  }

  /** Find smallest index where prefix sum > target (for scroll offset to index). */
  findIndex(target: number): number {
    let pos = 0;
    let bitMask = 1;
    while (bitMask <= this.size) bitMask <<= 1;
    bitMask >>= 1;

    let sum = 0;
    while (bitMask > 0) {
      const next = pos + bitMask;
      if (next <= this.size && sum + (this.tree[next] as number) <= target) {
        pos = next;
        sum += this.tree[next] as number;
      }
      bitMask >>= 1;
    }
    return Math.min(pos, this.size - 1);
  }
}
