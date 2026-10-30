/**
 * select(): derive one value from several stores, with one owner.
 *
 * `project` reads the states it is handed, never a store, so the list of
 * sources is the list of dependencies. The caller's AbortSignal owns every
 * subscription: aborting it unsubscribes them all, and a notification that
 * lands after abort is dropped. No batching is added: each store already
 * batches into one microtask notification, and the projection reruns
 * synchronously inside it.
 */

import { createLogger } from "../logger";
import { shallowEqual } from "../store";

const log = createLogger("select");

export interface Source<T> {
  getState(): T;
  /** select passes its own signal; a source may use it to end the subscription
   *  (eventSource does), and select also calls the returned unsubscribe on abort. */
  /** The listener is only told that something changed; select reads the state. */
  subscribe(listener: () => void, signal?: AbortSignal): () => void;
}

type StatesOf<S> = { readonly [K in keyof S]: S[K] extends Source<infer T> ? T : never };

export interface Selection<R> {
  get(): R;
}

export interface SelectOptions<R> {
  /** The only owner of the subscriptions. */
  readonly signal: AbortSignal;
  /** Defaults to store.ts's shallowEqual. */
  readonly equals?: (a: R, b: R) => boolean;
}

export function select<const S extends readonly Source<unknown>[], R>(
  sources: S,
  project: (...states: StatesOf<S>) => R,
  onChange: (next: R, prev: R) => void,
  opts: SelectOptions<R>,
): Selection<R> {
  const { signal, equals = shallowEqual } = opts;
  const distinct = [...new Set<Source<unknown>>(sources)];
  const run = (): R => project(...(sources.map((s) => s.getState()) as unknown as StatesOf<S>));
  let current = run();

  if (signal.aborted) return { get: () => current };

  const unsubs: Array<() => void> = [];
  const handler = (): void => {
    if (signal.aborted) return;
    let next: R;
    try {
      next = run();
    } catch (err) {
      log.error("projection threw; keeping the previous value", err);
      return;
    }
    if (equals(current, next)) return;
    const prev = current;
    current = next;
    try {
      onChange(next, prev);
    } catch (err) {
      log.error("onChange threw", err);
    }
  };
  for (const source of distinct) unsubs.push(source.subscribe(handler, signal));
  signal.addEventListener(
    "abort",
    () => {
      for (const unsub of unsubs) unsub();
    },
    { once: true },
  );
  return { get: () => current };
}

/**
 * A window event as a Source. getState() calls `read` once per event and
 * caches it. The listener lives and dies with the signal subscribe is given
 * (select passes its own), so an eventSource cannot be subscribed unowned.
 */
export function eventSource<T>(eventName: string, read: () => T): Source<T> {
  let cached: { readonly value: T } | null = null;
  let lastEvent: Event | null = null;
  let listening = 0;
  const get = (): T => {
    cached ??= { value: read() };
    return cached.value;
  };
  return {
    getState: () => {
      if (listening === 0) cached = null;
      return get();
    },
    subscribe(listener, signal) {
      // i18n-exempt: developer-facing misuse error, never shown to a user
      if (signal === undefined) throw new Error("eventSource.subscribe needs an owning signal");
      if (signal.aborted) return () => {};
      listening++;
      let active = true;
      const handler = (e: Event): void => {
        // The next getState() reads, inside select's try.
        if (e !== lastEvent) {
          lastEvent = e;
          cached = null;
        }
        listener();
      };
      const stop = (): void => {
        if (!active) return;
        active = false;
        listening--;
        window.removeEventListener(eventName, handler);
        signal.removeEventListener("abort", stop);
      };
      signal.addEventListener("abort", stop, { once: true });
      window.addEventListener(eventName, handler, { signal });
      return stop;
    },
  };
}
