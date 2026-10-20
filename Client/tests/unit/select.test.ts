import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@lib/store";
import { select, eventSource } from "@lib/select";
import { membersStore } from "@stores/members.store";
import { expectConsole } from "../helpers/console";
import { assertNoStoreReads, allStores } from "../helpers/storeReadGuard";

interface Box {
  n: number;
}
const box = (n = 0): Store<Box> => createStore<Box>({ n });

describe("select", () => {
  let ac: AbortController;
  const fresh = (): AbortSignal => {
    ac = new AbortController();
    return ac.signal;
  };
  afterEach(() => ac?.abort());

  it("projects once on call", () => {
    const project = vi.fn((a: Box) => a.n);
    const sel = select([box(3)], project, () => {}, { signal: fresh() });
    expect(project).toHaveBeenCalledTimes(1);
    expect(sel.get()).toBe(3);
  });

  it("reruns on any listed source", () => {
    const a = box(1);
    const b = box(10);
    const seen: Array<[number, number]> = [];
    const sel = select(
      [a, b],
      (x, y) => x.n + y.n,
      (n, p) => seen.push([n, p]),
      {
        signal: fresh(),
      },
    );
    a.setState(() => ({ n: 2 }));
    a.flush();
    b.setState(() => ({ n: 20 }));
    b.flush();
    expect(seen).toEqual([
      [12, 11],
      [22, 12],
    ]);
    expect(sel.get()).toBe(22);
  });

  it("equal result skips onChange", () => {
    const a = box(1);
    const onChange = vi.fn();
    select([a], (x) => ({ parity: x.n % 2 }), onChange, { signal: fresh() });
    a.setState(() => ({ n: 3 }));
    a.flush();
    expect(onChange).not.toHaveBeenCalled();
    a.setState(() => ({ n: 4 }));
    a.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("uses a custom equals", () => {
    const a = box(1);
    const onChange = vi.fn();
    select([a], (x) => x.n, onChange, { signal: fresh(), equals: () => true });
    a.setState(() => ({ n: 2 }));
    a.flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("abort unsubscribes every source and the event listener", () => {
    const a = box();
    const b = box();
    const unsubA = vi.spyOn(a, "subscribe");
    const onChange = vi.fn();
    const ev = eventSource("select-test-abort", () => Math.random());
    const remove = vi.spyOn(window, "addEventListener");
    select([a, b, ev], (x, y, z) => x.n + y.n + z, onChange, { signal: fresh() });
    expect(unsubA).toHaveBeenCalledTimes(1);
    ac.abort();
    a.setState(() => ({ n: 5 }));
    a.flush();
    b.setState(() => ({ n: 5 }));
    b.flush();
    window.dispatchEvent(new Event("select-test-abort"));
    expect(onChange).not.toHaveBeenCalled();
    remove.mockRestore();
  });

  it("aborted signal subscribes nothing", () => {
    const a = box(7);
    const sub = vi.spyOn(a, "subscribe");
    const add = vi.spyOn(window, "addEventListener");
    const c = new AbortController();
    c.abort();
    const sel = select([a, eventSource("select-test-pre", () => 1)], (x) => x.n, vi.fn(), {
      signal: c.signal,
    });
    expect(sub).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalledWith("select-test-pre", expect.anything(), expect.anything());
    expect(sel.get()).toBe(7);
    add.mockRestore();
    ac = new AbortController();
  });

  it("throwing projection keeps the previous value", () => {
    const a = box(1);
    const onChange = vi.fn();
    const sel = select(
      [a],
      (x) => {
        if (x.n === 2) throw new Error("boom"); // i18n-exempt: test fixture
        return x.n;
      },
      onChange,
      { signal: fresh() },
    );
    a.setState(() => ({ n: 2 }));
    a.flush();
    expectConsole("error", /projection threw/);
    expect(sel.get()).toBe(1);
    expect(onChange).not.toHaveBeenCalled();
    a.setState(() => ({ n: 3 }));
    a.flush();
    expect(sel.get()).toBe(3);
  });

  it("a throwing onChange keeps the new value and later notifications", () => {
    const a = box(1);
    let calls = 0;
    const sel = select(
      [a],
      (x) => x.n,
      () => {
        calls++;
        throw new Error("boom"); // i18n-exempt: test fixture
      },
      { signal: fresh() },
    );
    a.setState(() => ({ n: 2 }));
    a.flush();
    a.setState(() => ({ n: 3 }));
    a.flush();
    expectConsole("error", /onChange threw/);
    expectConsole("error", /onChange threw/);
    expect(calls).toBe(2);
    expect(sel.get()).toBe(3);
  });

  it("abort inside onChange stops later notifications in the same flush", () => {
    const a = box(1);
    const b = box(1);
    const seen: number[] = [];
    // Both sources notify in one flush each; the second must be dropped.
    select(
      [a, b],
      (x, y) => x.n + y.n,
      (n) => {
        seen.push(n);
        ac.abort();
      },
      { signal: fresh() },
    );
    a.setState(() => ({ n: 2 }));
    b.setState(() => ({ n: 2 }));
    a.flush();
    b.flush();
    expect(seen).toEqual([4]);
  });

  it("a source listed twice subscribes once", () => {
    const a = box(1);
    const sub = vi.spyOn(a, "subscribe");
    const project = vi.fn((x: Box, y: Box) => x.n + y.n);
    select([a, a], project, () => {}, { signal: fresh() });
    expect(sub).toHaveBeenCalledTimes(1);
    project.mockClear();
    a.setState(() => ({ n: 2 }));
    a.flush();
    expect(project).toHaveBeenCalledTimes(1);
  });
});

describe("eventSource", () => {
  it("caches read until the next event", () => {
    const read = vi.fn(() => ({ at: read.mock.calls.length }));
    const src = eventSource("select-test-cache", read);
    const ac = new AbortController();
    const seen: unknown[] = [];
    src.subscribe((s) => seen.push(s), ac.signal);
    expect(src.getState()).toBe(src.getState());
    expect(read).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("select-test-cache"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(src.getState()).toBe(seen[0]);
    expect(read).toHaveBeenCalledTimes(2);
    ac.abort();
    window.dispatchEvent(new Event("select-test-cache"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads once per event for several subscribers", () => {
    const read = vi.fn(() => 1);
    const src = eventSource("select-test-shared", read);
    const ac = new AbortController();
    src.subscribe(() => {}, ac.signal);
    src.subscribe(() => {}, ac.signal);
    window.dispatchEvent(new Event("select-test-shared"));
    expect(read).toHaveBeenCalledTimes(1);
    ac.abort();
  });

  it("refuses an unowned subscription", () => {
    expect(() => eventSource("select-test-unowned", () => 1).subscribe(() => {})).toThrow(
      /owning signal/,
    );
  });
});

describe("storeReadGuard", () => {
  it("finds the stores", () => {
    expect(allStores().size).toBeGreaterThan(5);
  });

  it("passes a builder that only uses the state it is given", () => {
    const state = membersStore.getState();
    expect(assertNoStoreReads(() => state.members.size)).toBe(0);
  });

  it("fails when a builder reads a store directly", () => {
    expect(() => assertNoStoreReads(() => membersStore.getState().members.size)).toThrow(
      /members\.store\.ts#membersStore\.getState/,
    );
    expect(() => assertNoStoreReads(() => membersStore.select((s) => s.members))).toThrow(
      /membersStore\.select/,
    );
  });
});
