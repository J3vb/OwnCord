/**
 * DOM list reconciliation utility.
 * Efficiently patches a container's children to match a new list of items,
 * preserving existing DOM elements where possible (no nuke-and-rebuild).
 *
 * Algorithm:
 *   1. Build a map of existing elements by key
 *   2. Walk the new items list:
 *      - If key exists in map → update in place, move to correct position
 *      - If key is new → create element, insert at correct position
 *   3. Remove any elements whose keys are no longer in the list
 *
 * This preserves hover states, focus, CSS transitions, and scroll position.
 */

export interface ReconcileOptions<T> {
  /** The container element whose children will be patched. */
  readonly container: Element;
  /** The new list of items to render. */
  readonly items: readonly T[];
  /** Extract a unique string key from each item. */
  readonly key: (item: T) => string;
  /** Create a new DOM element for an item. */
  readonly create: (item: T) => Element;
  /** Update an existing DOM element with new item data. Return the element. */
  readonly update: (el: Element, item: T) => void;
}

/**
 * Reconcile a container's children against a list of keyed items.
 * Preserves existing DOM elements, only adding/removing/reordering as needed.
 */
export function reconcileList<T>(opts: ReconcileOptions<T>): void {
  const { container, items, key, create, update } = opts;

  // Build map of existing children by data-key attribute
  const existingByKey = new Map<string, Element>();
  for (let i = container.children.length - 1; i >= 0; i--) {
    const child = container.children[i]!;
    const k = child.getAttribute("data-reconcile-key");
    if (k !== null) {
      existingByKey.set(k, child);
    }
  }

  const newKeys = new Set<string>();

  // Walk new items, create/update/reorder
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item);
    newKeys.add(k);

    let el = existingByKey.get(k);
    if (el !== undefined) {
      // Update existing element
      update(el, item);
    } else {
      // Create new element
      el = create(item);
      el.setAttribute("data-reconcile-key", k);
    }

    // Move/insert to correct position
    const currentAtPosition = container.children[i];
    if (currentAtPosition !== el) {
      container.insertBefore(el, currentAtPosition ?? null);
    }
  }

  // Remove elements whose keys are no longer in the list
  for (const [k, el] of existingByKey) {
    if (!newKeys.has(k)) {
      el.remove();
    }
  }
}
