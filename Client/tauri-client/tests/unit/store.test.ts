import { describe, it, expect, vi } from 'vitest';
import { createStore, shallowEqual } from '../../src/lib/store';

interface TestState {
  count: number;
  name: string;
}

const initialState: TestState = { count: 0, name: 'test' };

function freshStore() {
  return createStore<TestState>({ ...initialState });
}

describe('createStore', () => {
  it('getState returns initial state', () => {
    const store = freshStore();
    expect(store.getState()).toEqual({ count: 0, name: 'test' });
  });

  it('setState updates state via updater function', () => {
    const store = freshStore();
    store.setState((prev) => ({ ...prev, count: prev.count + 1 }));
    expect(store.getState()).toEqual({ count: 1, name: 'test' });
  });

  it('setState calls all subscribers with new state', () => {
    const store = freshStore();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    store.subscribe(listener1);
    store.subscribe(listener2);

    store.setState((prev) => ({ ...prev, count: 5 }));
    store.flush();

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener1).toHaveBeenCalledWith({ count: 5, name: 'test' });
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledWith({ count: 5, name: 'test' });
  });

  it('subscribe returns unsubscribe function that works', () => {
    const store = freshStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setState((prev) => ({ ...prev, count: 1 }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    store.setState((prev) => ({ ...prev, count: 2 }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all get called', () => {
    const store = freshStore();
    const calls: number[] = [];
    store.subscribe(() => calls.push(1));
    store.subscribe(() => calls.push(2));
    store.subscribe(() => calls.push(3));

    store.setState((prev) => ({ ...prev, count: 10 }));
    store.flush();

    expect(calls).toEqual([1, 2, 3]);
  });

  it('unsubscribed listener does not get called', () => {
    const store = freshStore();
    const kept = vi.fn();
    const removed = vi.fn();

    store.subscribe(kept);
    const unsub = store.subscribe(removed);
    unsub();

    store.setState((prev) => ({ ...prev, count: 99 }));
    store.flush();

    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('select derives value from state', () => {
    const store = freshStore();
    store.setState((prev) => ({ ...prev, count: 42 }));

    const count = store.select((s) => s.count);
    const name = store.select((s) => s.name);

    expect(count).toBe(42);
    expect(name).toBe('test');
  });

  it('setState does NOT mutate previous state reference', () => {
    const store = freshStore();
    const before = store.getState();

    store.setState((prev) => ({ ...prev, count: prev.count + 1 }));
    const after = store.getState();

    expect(before).toEqual({ count: 0, name: 'test' });
    expect(after).toEqual({ count: 1, name: 'test' });
    expect(before).not.toBe(after);
  });

  it('subscriber receives new state not old state', () => {
    const store = freshStore();
    const received: TestState[] = [];
    store.subscribe((s) => received.push(s));

    store.setState((prev) => ({ ...prev, count: 7 }));
    store.flush();
    store.setState((prev) => ({ ...prev, name: 'updated' }));
    store.flush();

    expect(received).toEqual([
      { count: 7, name: 'test' },
      { count: 7, name: 'updated' },
    ]);
  });

  it('no subscribers means setState still works without crash', () => {
    const store = freshStore();
    expect(() => {
      store.setState((prev) => ({ ...prev, count: 100 }));
    }).not.toThrow();
    expect(store.getState().count).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// subscribeSelector
// ---------------------------------------------------------------------------

describe('subscribeSelector', () => {
  it('fires when selected slice changes', () => {
    const store = freshStore();
    const listener = vi.fn();
    store.subscribeSelector((s) => s.count, listener);

    store.setState((prev) => ({ ...prev, count: 5 }));
    store.flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(5);
  });

  it('does NOT fire when selected slice is unchanged', () => {
    const store = freshStore();
    const listener = vi.fn();
    store.subscribeSelector((s) => s.count, listener);

    // Change name but not count
    store.setState((prev) => ({ ...prev, name: 'updated' }));
    store.flush();

    expect(listener).not.toHaveBeenCalled();
  });

  it('fires only for the changed slice among multiple selectors', () => {
    const store = freshStore();
    const countListener = vi.fn();
    const nameListener = vi.fn();
    store.subscribeSelector((s) => s.count, countListener);
    store.subscribeSelector((s) => s.name, nameListener);

    store.setState((prev) => ({ ...prev, count: 10 }));
    store.flush();

    expect(countListener).toHaveBeenCalledTimes(1);
    expect(nameListener).not.toHaveBeenCalled();
  });

  it('returns unsubscribe function', () => {
    const store = freshStore();
    const listener = vi.fn();
    const unsub = store.subscribeSelector((s) => s.count, listener);

    store.setState((prev) => ({ ...prev, count: 1 }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    store.setState((prev) => ({ ...prev, count: 2 }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1); // no new call
  });

  it('works with custom equality comparator', () => {
    const store = freshStore();
    const listener = vi.fn();
    // Custom comparator: only fire when count changes by more than 5
    store.subscribeSelector(
      (s) => s.count,
      listener,
      (a, b) => Math.abs(a - b) <= 5,
    );

    store.setState((prev) => ({ ...prev, count: 3 })); // diff = 3, within threshold
    store.flush();
    expect(listener).not.toHaveBeenCalled();

    store.setState((prev) => ({ ...prev, count: 10 })); // diff = 10, exceeds threshold
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(10);
  });

  it('works with microtask batching', () => {
    const store = freshStore();
    const listener = vi.fn();
    store.subscribeSelector((s) => s.count, listener);

    // Multiple rapid updates — only final state matters
    store.setState((prev) => ({ ...prev, count: 1 }));
    store.setState((prev) => ({ ...prev, count: 2 }));
    store.setState((prev) => ({ ...prev, count: 3 }));
    store.flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(3);
  });

  it('multiple selectors on the same store work independently', () => {
    const store = freshStore();
    const results: string[] = [];
    store.subscribeSelector((s) => s.count, (c) => results.push(`count:${c}`));
    store.subscribeSelector((s) => s.name, (n) => results.push(`name:${n}`));

    store.setState((prev) => ({ ...prev, count: 1, name: 'updated' }));
    store.flush();

    expect(results).toEqual(['count:1', 'name:updated']);
  });

  it('shallow-equal default prevents firing for structurally identical selectors', () => {
    const store = freshStore();
    const listener = vi.fn();
    // Selector creates a new object ref each time, but shallowEqual
    // detects that the content is unchanged and skips the notification.
    store.subscribeSelector(
      (s) => ({ count: s.count }),
      listener,
    );

    // Changing just name does NOT fire because { count: 0 } shallow-equals { count: 0 }
    store.setState((prev) => ({ ...prev, name: 'changed' }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(0);

    // Changing count DOES fire because { count: 1 } !== { count: 0 }
    store.setState((prev) => ({ ...prev, count: 1 }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('allows strict reference equality via custom comparator', () => {
    const store = freshStore();
    const listener = vi.fn();
    // Opt in to strict === comparison to get the old behavior
    store.subscribeSelector(
      (s) => ({ count: s.count }),
      listener,
      (a, b) => a === b,
    );

    // New object ref with same content DOES fire with strict ===
    store.setState((prev) => ({ ...prev, name: 'changed' }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// shallowEqual
// ---------------------------------------------------------------------------

describe('shallowEqual', () => {
  it('returns true for same reference', () => {
    const obj = { a: 1 };
    expect(shallowEqual(obj, obj)).toBe(true);
  });

  it('returns true for two identical plain objects', () => {
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it('returns false for objects with different values', () => {
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false for objects with different keys count', () => {
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('returns false when one side is null', () => {
    expect(shallowEqual(null, { a: 1 })).toBe(false);
    expect(shallowEqual({ a: 1 }, null)).toBe(false);
  });

  it('returns true for null === null', () => {
    expect(shallowEqual(null, null)).toBe(true);
  });

  it('returns false for non-object types', () => {
    expect(shallowEqual(1, 2)).toBe(false);
    expect(shallowEqual('a', 'b')).toBe(false);
  });

  it('returns true for same primitive values', () => {
    expect(shallowEqual(42, 42)).toBe(true);
    expect(shallowEqual('hello', 'hello')).toBe(true);
  });

  it('returns false when comparing object with primitive', () => {
    expect(shallowEqual({ a: 1 }, 42 as unknown)).toBe(false);
    expect(shallowEqual(42 as unknown, { a: 1 })).toBe(false);
  });

  // Map comparison
  it('returns true for identical Maps', () => {
    const a = new Map([['x', 1], ['y', 2]]);
    const b = new Map([['x', 1], ['y', 2]]);
    expect(shallowEqual(a, b)).toBe(true);
  });

  it('returns false for Maps with different size', () => {
    const a = new Map([['x', 1]]);
    const b = new Map([['x', 1], ['y', 2]]);
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('returns false for Maps with different keys', () => {
    const a = new Map([['x', 1]]);
    const b = new Map([['y', 1]]);
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('returns false for Maps with different values', () => {
    const a = new Map([['x', 1]]);
    const b = new Map([['x', 2]]);
    expect(shallowEqual(a, b)).toBe(false);
  });

  // Set comparison
  it('returns true for identical Sets', () => {
    const a = new Set([1, 2, 3]);
    const b = new Set([1, 2, 3]);
    expect(shallowEqual(a, b)).toBe(true);
  });

  it('returns false for Sets with different size', () => {
    const a = new Set([1, 2]);
    const b = new Set([1, 2, 3]);
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('returns false for Sets with different values', () => {
    const a = new Set([1, 2]);
    const b = new Set([1, 3]);
    expect(shallowEqual(a, b)).toBe(false);
  });

  // Array comparison
  it('returns true for identical arrays', () => {
    expect(shallowEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('returns false for arrays with different length', () => {
    expect(shallowEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('returns false for arrays with different elements', () => {
    expect(shallowEqual([1, 2], [1, 3])).toBe(false);
  });

  it('returns true for empty arrays', () => {
    expect(shallowEqual([], [])).toBe(true);
  });

  it('returns true for empty Maps', () => {
    expect(shallowEqual(new Map(), new Map())).toBe(true);
  });

  it('returns true for empty Sets', () => {
    expect(shallowEqual(new Set(), new Set())).toBe(true);
  });

  it('returns true for empty objects', () => {
    expect(shallowEqual({}, {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flush edge cases
// ---------------------------------------------------------------------------

describe('flush edge cases', () => {
  it('flush when no notification is scheduled does nothing', () => {
    const store = freshStore();
    const listener = vi.fn();
    store.subscribe(listener);
    // flush without any setState should not fire listeners
    store.flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('double flush only fires once', () => {
    const store = freshStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState((prev) => ({ ...prev, count: 1 }));
    store.flush();
    store.flush(); // second flush should be no-op
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribeSelector with Map values uses shallowEqual', () => {
    interface MapState {
      items: Map<string, number>;
    }
    const store = createStore<MapState>({ items: new Map([['a', 1]]) });
    const listener = vi.fn();
    store.subscribeSelector((s) => s.items, listener);

    // Same map reference, no change
    store.setState((prev) => ({ ...prev }));
    store.flush();
    expect(listener).not.toHaveBeenCalled();

    // New map with same content -- shallowEqual returns true, so no fire
    store.setState((prev) => ({ items: new Map([['a', 1]]) }));
    store.flush();
    expect(listener).not.toHaveBeenCalled();

    // Different content
    store.setState(() => ({ items: new Map([['a', 2]]) }));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
