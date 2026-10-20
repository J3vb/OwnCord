/**
 * Store-read guard (5.4b). A row builder fed by `select` must be a pure
 * function of the states it is handed. `assertNoStoreReads` spies `getState`
 * and `select` on every store exported by src/stores/*.store.ts and
 * src/features/{star}/store.ts, runs the builder, and fails naming each store
 * that was read directly.
 *
 * Limit: only store reads are visible. Non-store inputs (channel mutes, the
 * local user mute, a preference) are read through eventSource; a builder that
 * reads one of those directly passes this guard, so review those by hand.
 */

import { vi } from "vitest";

interface ReadableStore {
  getState: (...args: never[]) => unknown;
  select: (...args: never[]) => unknown;
  subscribe: (...args: never[]) => unknown;
}

function isStore(v: unknown): v is ReadableStore {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["getState"] === "function" &&
    typeof o["select"] === "function" &&
    typeof o["subscribe"] === "function"
  );
}

const modules = {
  ...import.meta.glob<Record<string, unknown>>("../../src/stores/*.store.ts", { eager: true }),
  ...import.meta.glob<Record<string, unknown>>("../../src/features/*/store.ts", { eager: true }),
};

/** Every store export, named "path#export". */
export function allStores(): ReadonlyMap<string, ReadableStore> {
  const found = new Map<string, ReadableStore>();
  for (const [path, mod] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(mod)) {
      if (isStore(value)) found.set(`${path.replace("../../src/", "")}#${name}`, value);
    }
  }
  return found;
}

/** Run `build`; throw if it read any store's state directly. Returns its value. */
export function assertNoStoreReads<T>(build: () => T): T {
  const reads = new Set<string>();
  const spies: Array<{ mockRestore(): void }> = [];
  for (const [name, store] of allStores()) {
    for (const method of ["getState", "select"] as const) {
      const real = store[method] as (...args: unknown[]) => unknown;
      spies.push(
        vi.spyOn(store, method).mockImplementation(((...args: unknown[]) => {
          reads.add(`${name}.${method}`);
          return real.apply(store, args);
        }) as never),
      );
    }
  }
  try {
    const out = build();
    if (reads.size > 0) {
      throw new Error(`builder read stores directly: ${[...reads].toSorted().join(", ")}`);
    }
    return out;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
