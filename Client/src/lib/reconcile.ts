/**
 * Minimal keyed-list reconciler (B9-21).
 *
 * The sidebars used to `clearChildren()` and rebuild every row on every store
 * notification — every message in another channel, every DM partner presence
 * flip. That replaced the whole subtree, so node identity, keyboard focus and
 * scroll position were all lost, and the work scaled with the list length
 * rather than with the change.
 *
 * This keeps a row's DOM node when its key is unchanged and its signature
 * (everything the row renders) is unchanged, creates one only for a new or
 * changed row, and removes the rows that are gone. Focus and row identity then
 * survive an unrelated update for free.
 *
 * It is deliberately not a virtual DOM: `signature` is the caller's honest
 * statement of what the row draws, and a stale signature is a stale row. Call
 * it with a signature that covers every field `create` reads.
 */

/** One node's remembered identity, keyed by the DOM node itself. */
interface NodeMeta {
  readonly key: string;
  readonly sig: string;
}

const META = new WeakMap<Element, NodeMeta>();

export interface ReconcileOptions<T> {
  /** Stable identity of the row; a changed key means a different row. */
  readonly key: (item: T) => string;
  /** Everything the row renders. A changed signature rebuilds just that row. */
  readonly signature: (item: T) => string;
  /** Build a row. Called only for a new or changed key. */
  readonly create: (item: T) => Element;
  /**
   * Called for a reused row (same key, same signature). Lets a container row
   * keep a coarse signature — its own chrome rather than its children — and
   * reconcile those children here.
   */
  readonly update?: (el: Element, item: T) => void;
  /** Release a removed/replaced row's listeners before it is detached. */
  readonly dispose?: (el: Element) => void;
}

/**
 * Make `container`'s element children exactly one row per item, in order.
 * Returns the number of rows built (0 means every row was reused).
 *
 * If the row root itself had focus and had to be replaced (its content
 * changed), focus moves to the replacement row so an async update never drops
 * the user mid-list. Focus on a descendant of a rebuilt row is the caller's
 * to restore: it knows which descendant matters, and `dispose` runs before the
 * row detaches.
 */
export function reconcileChildren<T>(
  container: Element,
  items: readonly T[],
  opts: ReconcileOptions<T>,
): number {
  const { key, signature, create, update, dispose } = opts;

  // Index the rows already present by key, once — O(n), not O(n^2).
  const existing = new Map<string, Element>();
  for (const child of Array.from(container.children)) {
    const meta = META.get(child);
    if (meta !== undefined) existing.set(meta.key, child);
  }

  // Remember whether a row root had focus, and which key it belonged to.
  const active = document.activeElement;
  const focusedKey =
    active !== null && active.parentElement === container ? (META.get(active)?.key ?? null) : null;

  const wanted = new Map<string, Element>();
  let built = 0;

  for (const item of items) {
    const k = key(item);
    const sig = signature(item);
    const current = existing.get(k);
    if (current !== undefined) {
      const currentMeta = META.get(current);
      if (currentMeta !== undefined && currentMeta.sig === sig) {
        update?.(current, item);
        existing.delete(k);
        wanted.set(k, current);
        continue;
      }
      // Same key, changed content: replace the node so the row redraws fresh.
      dispose?.(current);
      current.remove();
      existing.delete(k);
    }
    const el = create(item);
    META.set(el, { key: k, sig });
    wanted.set(k, el);
    built++;
  }

  // Whatever is left in `existing` is gone from the new list.
  for (const [k, el] of existing) {
    dispose?.(el);
    el.remove();
    existing.delete(k);
  }

  // Place every row at its target index. insertBefore moves an existing node,
  // so this both inserts the new rows and reorders the kept ones.
  items.forEach((item, i) => {
    const el = wanted.get(key(item));
    if (el !== undefined && container.children[i] !== el) {
      container.insertBefore(el, container.children[i] ?? null);
    }
  });

  // The focused row was rebuilt: hand focus to its replacement. A row root is
  // focusable when the caller tabs/arrows into it (tabindex set); focus() on a
  // non-focusable element is a harmless no-op.
  if (focusedKey !== null && active !== null && !active.isConnected) {
    (wanted.get(focusedKey) as HTMLElement | undefined)?.focus();
  }

  return built;
}
