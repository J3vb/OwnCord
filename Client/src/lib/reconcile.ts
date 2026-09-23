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
 * Make `container`'s element children exactly one row per item, in order.
 * Returns the number of rows built.
 *
 * If the focused row root had to be replaced, focus moves to its replacement,
 * so an async update never drops the user mid-list.
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
  const focusedKey =
    active !== null && active.parentElement === container ? (META.get(active)?.key ?? null) : null;

  const wanted = new Map<string, Element>();
  let built = 0;
  for (const item of items) {
    const k = key(item);
    const sig = signature(item);
    const current = existing.get(k);
    existing.delete(k);
    const meta = current === undefined ? undefined : META.get(current);
    if (current !== undefined && meta !== undefined && meta.sig === sig) {
      update?.(current, item);
      wanted.set(k, current);
      continue;
    }
    if (current !== undefined) {
      dispose?.(current);
      current.remove();
    }
    const el = create(item);
    META.set(el, { key: k, sig });
    wanted.set(k, el);
    built++;
  }
  for (const [k, el] of existing) {
    dispose?.(el);
    el.remove();
    existing.delete(k);
  }
  // insertBefore moves an existing node, so this inserts new rows and reorders
  // the kept ones in one pass.
  items.forEach((item, i) => {
    const el = wanted.get(key(item));
    if (el !== undefined && container.children[i] !== el) {
      container.insertBefore(el, container.children[i] ?? null);
    }
  });
  if (focusedKey !== null && active !== null && !active.isConnected) {
    (wanted.get(focusedKey) as HTMLElement | undefined)?.focus();
  }
  return built;
}
