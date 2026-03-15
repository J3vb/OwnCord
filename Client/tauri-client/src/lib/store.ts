/**
 * Generic reactive store foundation for OwnCord Tauri client.
 * Immutable state updates only — setState receives an updater
 * that must return a NEW state object.
 */

export interface Store<T> {
  /** Returns the current state (immutable reference). */
  getState(): T;

  /** Update state via an updater function. Listeners are called synchronously. */
  setState(updater: (prev: T) => T): void;

  /**
   * Subscribe to state changes. The listener receives the new state
   * after every setState call. Returns an unsubscribe function.
   */
  subscribe(listener: (state: T) => void): () => void;

  /** Derive a value from the current state using a selector function. */
  select<S>(selector: (state: T) => S): S;
}

export function createStore<T>(initialState: T): Store<T> {
  let state: T = initialState;
  const listeners: Set<(state: T) => void> = new Set();

  function getState(): T {
    return state;
  }

  function setState(updater: (prev: T) => T): void {
    state = updater(state);
    for (const listener of listeners) {
      listener(state);
    }
  }

  function subscribe(listener: (state: T) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function select<S>(selector: (state: T) => S): S {
    return selector(state);
  }

  return { getState, setState, subscribe, select };
}
