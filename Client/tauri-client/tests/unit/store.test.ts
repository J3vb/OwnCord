import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../../src/lib/store';

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
