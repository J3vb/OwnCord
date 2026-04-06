/**
 * Phase B Step 6 — Solid.js adapter.
 *
 * Bridges the existing custom reactive `Store<T>` (lib/store.ts) into Solid's
 * signal model so migrated components can read from existing stores without
 * touching them. Vanilla and Solid components coexist throughout the
 * migration: a vanilla component can update a store, and any Solid component
 * subscribed via this adapter sees the new value through its accessor.
 *
 * Usage from a Solid component:
 *
 *   import { fromStore } from "@lib/solidAdapter";
 *   import { authStore } from "@stores/auth";
 *
 *   const auth = fromStore(authStore);
 *   return <div>{auth().username}</div>;
 *
 * The accessor returned by fromStore is a Solid signal getter, so it triggers
 * fine-grained reactivity in any computation, JSX expression, or `createMemo`.
 */

import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Store } from "./store";

/**
 * Wrap a custom Store as a Solid signal accessor. The signal updates whenever
 * the underlying store fires, and the subscription is torn down when the
 * Solid owner is disposed (so leaf components don't leak listeners).
 */
export function fromStore<T>(store: Store<T>): Accessor<T> {
  const [value, setValue] = createSignal<T>(store.getState(), { equals: false });
  const unsub = store.subscribe((next) => setValue(() => next));
  onCleanup(unsub);
  return value;
}

/**
 * Wrap a derived slice of a store. Equivalent to fromStore(store).map(selector)
 * but uses the store's native subscribeSelector so changes are gated by the
 * existing equality comparator.
 */
export function fromStoreSlice<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  isEqual?: (a: S, b: S) => boolean,
): Accessor<S> {
  const initial = selector(store.getState());
  const [value, setValue] = createSignal<S>(initial, { equals: false });
  const unsub = store.subscribeSelector(
    selector,
    (next) => setValue(() => next),
    isEqual,
  );
  onCleanup(unsub);
  return value;
}
