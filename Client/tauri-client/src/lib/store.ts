/**
 * Generic reactive store foundation for OwnCord Tauri client.
 * Immutable state updates only — setState receives an updater
 * that must return a NEW state object.
 *
 * Subscription flow:
 *
 *   setState(updater)
 *        │
 *        ▼
 *   queueMicrotask (batch)
 *        │
 *        ├─► subscribe() listeners    ← fire on EVERY change
 *        │
 *        └─► subscribeSelector()      ← fire only when selected
 *            listeners                   slice changes (via ===)
 */

export interface Store<T> {
  /** Returns the current state (immutable reference). */
  getState(): T;

  /**
   * Update state via an updater function. Subscriber notifications are
   * batched via queueMicrotask — multiple rapid setState calls result
   * in a single notification with the final state.
   */
  setState(updater: (prev: T) => T): void;

  /**
   * Subscribe to state changes. The listener receives the new state
   * after every setState batch. Returns an unsubscribe function.
   */
  subscribe(listener: (state: T) => void): () => void;

  /**
   * Subscribe to a derived slice of state. The listener only fires when
   * the selector's return value changes (by default via `===`).
   *
   * IMPORTANT: Selectors must return stable references for unchanged data.
   * A selector like `s => ({ ...s.users })` creates a new object every time
   * and will fire on every update, defeating the purpose. Instead use
   * `s => s.users` to return the existing reference, or pass a custom
   * `isEqual` comparator for value-based comparison.
   */
  subscribeSelector<S>(
    selector: (state: T) => S,
    listener: (selected: S) => void,
    isEqual?: (a: S, b: S) => boolean,
  ): () => void;

  /** Derive a value from the current state using a selector function. */
  select<S>(selector: (state: T) => S): S;

  /** Flush pending notifications synchronously (useful in tests). */
  flush(): void;
}

export function createStore<T>(initialState: T): Store<T> {
  let state: T = initialState;
  const listeners: Set<(state: T) => void> = new Set();
  let notifyScheduled = false;

  function getState(): T {
    return state;
  }

  function setState(updater: (prev: T) => T): void {
    state = updater(state);
    if (!notifyScheduled) {
      notifyScheduled = true;
      queueMicrotask(() => {
        notifyScheduled = false;
        for (const listener of listeners) {
          listener(state);
        }
      });
    }
  }

  function subscribe(listener: (state: T) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function subscribeSelector<S>(
    selector: (state: T) => S,
    listener: (selected: S) => void,
    isEqual: (a: S, b: S) => boolean = (a, b) => a === b,
  ): () => void {
    let prev: S = selector(state);
    return subscribe((newState) => {
      const next = selector(newState);
      if (!isEqual(prev, next)) {
        prev = next;
        listener(next);
      }
    });
  }

  function select<S>(selector: (state: T) => S): S {
    return selector(state);
  }

  function flush(): void {
    if (notifyScheduled) {
      notifyScheduled = false;
      for (const listener of listeners) {
        listener(state);
      }
    }
  }

  return { getState, setState, subscribe, subscribeSelector, select, flush };
}
