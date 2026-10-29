/**
 * Minimal keyed-list reconciler.
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
  /** `reconcileChildren` rows: the caller's signature. Empty for model rows. */
  sig: string;
  /** `reconcileModels` rows: the model the node was last drawn or patched to. */
  model?: RowModel;
  /** `reconcileModels` rows: the live item a handler reads through `atEvent`. */
  ref?: { item: unknown; creating: boolean };
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
 *
 * Rows nested inside a row (a reconciled list inside a reconciled row) are
 * followed by key: focus on an inner row, or a control in one, lands on the
 * inner row with the same key in the replacement, then on the same control
 * inside it. For that, the replacement's nested rows must exist when this
 * pass ends, so an outer `create` builds its nested rows itself (running the
 * inner reconcile) rather than leaving them to a later pass.
 */
export function reconcileChildren<T>(
  container: Element,
  items: readonly T[],
  opts: ReconcileOptions<T>,
): number {
  const { key, signature, create, update, dispose } = opts;
  return reconcileKeyed(
    container,
    items,
    key,
    (item, k, current) => {
      const sig = signature(item);
      if (current !== undefined && META.get(current)!.sig === sig) {
        update?.(current, item);
        return { el: current, reused: true };
      }
      const el = create(item);
      META.set(el, { key: k, sig });
      return { el, reused: false };
    },
    dispose,
  );
}

/** What one item became: its node, and whether an existing node was kept. */
interface Visit {
  el: Element;
  reused: boolean;
}

/**
 * The shared pass under both entry points: look rows up by key, let `visit`
 * decide reuse or build per item, drop the gone ones, then move as few nodes
 * as possible and keep focus. Returns the number of rows built.
 */
function reconcileKeyed<T>(
  container: Element,
  items: readonly T[],
  key: (item: T) => string,
  visit: (item: T, k: string, current: Element | undefined) => Visit,
  dispose: ((el: Element) => void) | undefined,
): number {
  const existing = new Map<string, Element>();
  for (const child of Array.from(container.children)) {
    const meta = META.get(child);
    if (meta !== undefined) existing.set(meta.key, child);
  }
  const active = document.activeElement;
  let holder = active;
  while (holder !== null && holder.parentElement !== container) holder = holder.parentElement;
  const focusedKey = holder === null ? undefined : META.get(holder)?.key;
  // The keys of the nested rows between the focused element and its row,
  // outermost first, read from META now: a stored path would go stale when a
  // nested row moves to another parent.
  const innerPath: string[] = [];
  for (let n = holder === null ? null : active; n !== null && n !== holder; n = n.parentElement) {
    const k = META.get(n)?.key;
    if (k !== undefined) innerPath.unshift(k);
  }
  const activeIsRow = active !== null && active !== holder && META.has(active);

  const wanted: Element[] = [];
  let built = 0;
  for (const item of items) {
    const k = key(item);
    const current = existing.get(k);
    existing.delete(k);
    const { el, reused } = visit(item, k, current);
    if (!reused) {
      if (current !== undefined) existing.set(k, current);
      built++;
    }
    wanted.push(el);
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
      // Follow the nested keys as deep as they still match.
      let base: Element = next;
      let matched = 0;
      for (const k of innerPath) {
        const inner = nestedRow(base, k);
        if (inner === undefined) break;
        base = inner;
        matched++;
      }
      const target =
        matched === innerPath.length && activeIsRow
          ? base
          : [base, ...base.querySelectorAll("*")].find(same);
      (target as HTMLElement | undefined)?.focus();
    }
  }
  return built;
}

/**
 * The first row below `base` with `key` whose nearest row ancestor is `base`
 * itself, so a key never matches a row one level deeper.
 */
function nestedRow(base: Element, key: string): Element | undefined {
  for (const el of base.querySelectorAll("*")) {
    if (META.get(el)?.key !== key) continue;
    let up = el.parentElement;
    while (up !== null && up !== base && !META.has(up)) up = up.parentElement;
    if (up === base) return el;
  }
  return undefined;
}

/** Plain data a row model may hold: no `undefined`, functions, Maps or Elements,
 *  so a model compares structurally and cannot smuggle live state. */
export type ModelValue =
  string | number | boolean | null | readonly ModelValue[] | { readonly [k: string]: ModelValue };
export type RowModel = { readonly [k: string]: ModelValue };

/** Structural equality over ModelValue; key order ignored. */
export function sameModel(a: ModelValue, b: ModelValue): boolean {
  if (a === b || (a !== a && b !== b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const other = b as readonly ModelValue[];
    return (a as readonly ModelValue[]).every((v, i) => sameModel(v, other[i]!));
  }
  const left = a as { readonly [k: string]: ModelValue };
  const right = b as { readonly [k: string]: ModelValue };
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => Object.hasOwn(right, k) && sameModel(left[k]!, right[k]!))
  );
}

/** Every field name of `M`; for a union of models, the names of any member. */
type FieldOf<M> = M extends unknown ? keyof M & string : never;

export interface ModelRowOptions<T, M extends RowModel> {
  key: (item: T) => string;
  model: (item: T) => M;
  /** Draw from the model only. `atEvent` returns the live item for handlers;
   *  calling it while `create` runs throws. */
  create: (model: M, atEvent: () => T) => Element;
  /** Fields changed in place without a rebuild (status dot, speaking). */
  patch?: {
    readonly fields: readonly FieldOf<M>[];
    readonly apply: (el: Element, next: M) => void;
  };
  /** Reused row (equal or patched): reconcile nested children, refresh refs. */
  update?: (el: Element, item: T, model: M) => void;
  dispose?: (el: Element) => void;
}

/** The names of the fields on which two models differ. */
function changedFields(a: RowModel, b: RowModel): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter(
    (k) => !(Object.hasOwn(a, k) && Object.hasOwn(b, k) && sameModel(a[k]!, b[k]!)),
  );
}

/**
 * `reconcileChildren` with the signature derived from a row model: the model is
 * the drawn values as plain data, so a row cannot draw what its model omits
 * and no field is listed twice. A row is kept when its model is equal to the
 * last one, patched in place when only `patch.fields` differ, and rebuilt
 * otherwise. Focus and moves are handled exactly as in `reconcileChildren`.
 * Returns the number of rows built.
 */
export function reconcileModels<T, M extends RowModel>(
  container: Element,
  items: readonly T[],
  opts: ModelRowOptions<T, M>,
): number {
  const { key, model, create, patch, update, dispose } = opts;
  const patchable: ReadonlySet<string> = new Set(patch?.fields ?? []);
  return reconcileKeyed(
    container,
    items,
    key,
    (item, k, current) => {
      const next = model(item);
      const meta = current === undefined ? undefined : META.get(current);
      if (current !== undefined && meta?.model !== undefined && meta.ref !== undefined) {
        const changed = changedFields(meta.model, next);
        if (changed.every((f) => patchable.has(f))) {
          meta.ref.item = item;
          if (changed.length > 0) {
            patch?.apply(current, next);
            meta.model = next;
          }
          update?.(current, item, next);
          return { el: current, reused: true };
        }
      }
      const ref = { item: item as unknown, creating: true };
      const atEvent = (): T => {
        // i18n-exempt: developer diagnostic for a programming error, never shown
        if (ref.creating) throw new Error("atEvent called while the row is being created");
        return ref.item as T;
      };
      const el = create(next, atEvent);
      ref.creating = false;
      META.set(el, { key: k, sig: "", model: next, ref });
      return { el, reused: false };
    },
    dispose,
  );
}
