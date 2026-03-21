/**
 * Disposable — automatic cleanup manager for component lifecycles.
 * Tracks subscriptions, event listeners, and intervals. Calling destroy()
 * flushes all cleanups at once, preventing memory leaks from forgotten unsubs.
 */

type CleanupFn = () => void;

export class Disposable {
  private readonly cleanups: CleanupFn[] = [];
  private readonly ac = new AbortController();
  private destroyed = false;

  /** The AbortSignal for this disposable — pass to addEventListener({ signal }). */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** Register an arbitrary cleanup function. */
  addCleanup(fn: CleanupFn): void {
    if (this.destroyed) {
      fn();
      return;
    }
    this.cleanups.push(fn);
  }

  /** Subscribe to a store with a selector, auto-tracked for cleanup. */
  onStoreChange<S, R>(
    store: { subscribeSelector(selector: (s: S) => R, callback: (val: R) => void): () => void },
    selector: (s: S) => R,
    callback: (val: R) => void,
  ): void {
    const unsub = store.subscribeSelector(selector, callback);
    this.addCleanup(unsub);
  }

  /** Add an event listener auto-tracked via AbortController signal. */
  onEvent<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window | Document,
    event: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, {
      ...options,
      signal: this.ac.signal,
    });
  }

  /** Set an interval, auto-tracked for cleanup. */
  onInterval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.addCleanup(() => clearInterval(id));
  }

  /** Flush all cleanups: abort listeners, run cleanup fns. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ac.abort();
    for (const fn of this.cleanups) {
      fn();
    }
    this.cleanups.length = 0;
  }
}
