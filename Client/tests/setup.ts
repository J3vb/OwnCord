// Vitest global setup for the jsdom suite.
//
// Why this exists: Node 26 defines `localStorage` as a native global accessor
// that returns `undefined` unless the process was started with
// `--localstorage-file`. Vitest's jsdom environment makes `window === globalThis`,
// so that native accessor shadows the one jsdom would otherwise install, and
// every test touching `localStorage` throws. `sessionStorage` is unaffected —
// jsdom's implementation still wins there.
//
// We deliberately do NOT pass `--localstorage-file`: it is file-backed and would
// be shared by vitest's parallel workers, leaking state between test files.

/**
 * Minimal in-memory Web Storage implementation used to replace the shadowed
 * `localStorage` global.
 *
 * Matches the spec on the three points app code depends on: `getItem` returns
 * `null` (not `undefined`) for absent keys, `setItem` coerces values to strings,
 * and `key(i)` enumerates in insertion order — src/lib/themes.ts:30 and
 * src/components/settings/AdvancedTab.ts:351 both sweep storage via `key(i)`
 * over `length`, so ordering is load-bearing.
 */
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length(): number {
      return store.size;
    },
    key(index: number): string | null {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return store.get(String(key)) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(String(key), String(value));
    },
    removeItem(key: string): void {
      store.delete(String(key));
    },
    clear(): void {
      store.clear();
    },
  } satisfies Storage;
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

// jsdom never lays anything out, so it doesn't implement scrollIntoView at
// all (not even as a no-op) — components that call it (e.g. the mention/emoji
// autocomplete's arrow-key scroll) throw "is not a function" under jsdom.
// Every real browser has it; this just fills the gap.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
