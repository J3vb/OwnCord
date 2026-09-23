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
  // insertBefore moves an existing node, so this inserts new rows and reorders
  // the kept ones in one pass.
  wanted.forEach((el, i) => {
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null);
  });
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
