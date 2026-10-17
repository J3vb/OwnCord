/**
 * Minimal keyed-list reconciler (B9-21).
 *
 * The sidebars used to `clearChildren()` and rebuild every row on every store
 * notification — every message in another channel, every DM partner presence
 * flip — losing node identity, focus and scroll, and doing work proportional
 * to the list rather than to the change. This reuses a row's node while its
 * `key` and `signature` (everything the row draws) are unchanged, builds one
 * only for a new or changed row, and removes the ones that are gone.
 *
 * It is not a virtual DOM: `signature` is the caller's honest statement of
 * what the row draws, and a stale signature is a stale row.
 */

interface NodeMeta {
  key: string;
  sig: string;
}

const META = new WeakMap<Element, NodeMeta>();

export interface ReconcileOptions<T> {
  /** Stable identity of the row; a changed key means a different row. */
  key: (item: T) => string;
  /** Everything the row renders. A changed signature rebuilds just that row. */
  signature: (item: T) => string;
  /** Build a row. Called only for a new or changed key. */
  create: (item: T) => Element;
  /** Called for a reused row, so a container can reconcile its own children. */
  update?: (el: Element, item: T) => void;
  /** Release a removed/replaced row's listeners before it detaches. */
  dispose?: (el: Element) => void;
}

/**
 * Positions (in `values`) of one longest strictly increasing subsequence,
 * ignoring negative entries (new nodes). Patience sort, O(n log n).
 */
function longestIncreasingRun(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = Array.from({ length: values.length }, () => -1);
  values.forEach((v, i) => {
    if (v < 0) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

/**
 * Make `container`'s element children exactly one row per item, in order.
 * The container must hold only reconciled children: an untracked child is not
 * removed here and would break the move pass, so callers clear those first.
 * Returns the number of rows built.
 *
 * If a row held focus (itself or a control inside it), focus stays on it
 * when it is only moved, and moves to the same control in its replacement when
 * it is rebuilt, so an async update never drops the user mid-list. "The same control" is the first element in the new row with
 * the focused one's tag, first class and `data-testid`.
 */
export function reconcileChildren<T>(
  container: Element,
  items: readonly T[],
  opts: ReconcileOptions<T>,
): number {
  const { key, signature, create, update, dispose } = opts;
  const existing = new Map<string, Element>();
  for (const child of Array.from(container.children)) {
    const meta = META.get(child);
    if (meta !== undefined) existing.set(meta.key, child);
  }
  const active = document.activeElement;
  let holder = active;
  while (holder !== null && holder.parentElement !== container) holder = holder.parentElement;
  const focusedKey = holder === null ? undefined : META.get(holder)?.key;

  const wanted: Element[] = [];
  let built = 0;
  for (const item of items) {
    const k = key(item);
    const sig = signature(item);
    const current = existing.get(k);
    existing.delete(k);
    if (current !== undefined && META.get(current)!.sig === sig) {
      update?.(current, item);
      wanted.push(current);
      continue;
    }
    if (current !== undefined) existing.set(k, current);
    const el = create(item);
    META.set(el, { key: k, sig });
    wanted.push(el);
    built++;
  }
  for (const el of existing.values()) {
    dispose?.(el);
    el.remove();
  }
  // Move as few nodes as possible: the kept rows already in relative order (a
  // longest increasing subsequence of their old positions) stay put, and only
  // new rows and the rows outside that run are inserted. One logical move is
  // one DOM move, and a focused row is not touched unless it is the one moving.
  const oldIndex = new Map<Element, number>();
  Array.from(container.children).forEach((child, i) => oldIndex.set(child, i));
  const stay = longestIncreasingRun(wanted.map((el) => oldIndex.get(el) ?? -1));
  let anchor: Element | null = null;
  for (let i = wanted.length - 1; i >= 0; i--) {
    const el = wanted[i]!;
    if (!stay.has(i)) container.insertBefore(el, anchor);
    anchor = el;
  }
  if (active === null || focusedKey === undefined || document.activeElement === active) {
    return built;
  }
  if (active.isConnected) {
    (active as HTMLElement).focus();
  } else {
    const next = wanted.find((el) => META.get(el)!.key === focusedKey);
    const same = (el: Element): boolean =>
      el.tagName === active.tagName &&
      el.classList[0] === active.classList[0] &&
      el.getAttribute("data-testid") === active.getAttribute("data-testid");
    if (next !== undefined) {
      ([next, ...next.querySelectorAll("*")].find(same) as HTMLElement | undefined)?.focus();
    }
  }
  return built;
}
