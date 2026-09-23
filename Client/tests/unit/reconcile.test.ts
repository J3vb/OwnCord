import { describe, it, expect } from "vitest";
import { reconcileChildren } from "../../src/lib/reconcile";
import { createElement } from "../../src/lib/dom";

interface Row {
  id: number;
  label: string;
}

const opts = {
  key: (r: Row) => String(r.id),
  signature: (r: Row) => r.label,
  create: (r: Row) => createElement("div", { "data-id": String(r.id) }, r.label),
};

function ids(container: Element): string[] {
  return Array.from(container.children).map((el) => (el as HTMLElement).dataset.id ?? "");
}

function labels(container: Element): string[] {
  return Array.from(container.children).map((el) => el.textContent ?? "");
}

describe("reconcileChildren", () => {
  it("builds every row on the first pass", () => {
    const container = document.createElement("div");
    const built = reconcileChildren(
      container,
      [
        { id: 1, label: "a" },
        { id: 2, label: "b" },
      ],
      opts,
    );
    expect(built).toBe(2);
    expect(ids(container)).toEqual(["1", "2"]);
  });

  it("reuses unchanged rows across a re-render", () => {
    const container = document.createElement("div");
    const items = [
      { id: 1, label: "a" },
      { id: 2, label: "b" },
    ];
    reconcileChildren(container, items, opts);
    const before = Array.from(container.children);

    const built = reconcileChildren(container, items, opts);
    expect(built).toBe(0);
    expect(Array.from(container.children)).toEqual(before);
  });

  it("rebuilds only the row whose signature changed, keeping the others", () => {
    const container = document.createElement("div");
    reconcileChildren(
      container,
      [
        { id: 1, label: "a" },
        { id: 2, label: "b" },
        { id: 3, label: "c" },
      ],
      opts,
    );
    const row1 = container.children[0];
    const row3 = container.children[2];

    reconcileChildren(
      container,
      [
        { id: 1, label: "a" },
        { id: 2, label: "B!" },
        { id: 3, label: "c" },
      ],
      opts,
    );
    expect(container.children[0]).toBe(row1);
    expect(container.children[2]).toBe(row3);
    expect(labels(container)).toEqual(["a", "B!", "c"]);
  });

  it("inserts, removes and reorders while keeping surviving identities", () => {
    const container = document.createElement("div");
    reconcileChildren(
      container,
      [
        { id: 1, label: "a" },
        { id: 2, label: "b" },
        { id: 3, label: "c" },
      ],
      opts,
    );
    const row1 = container.children[0];
    const row2 = container.children[1];

    // New head, reorder, and row 3 gone.
    reconcileChildren(
      container,
      [
        { id: 4, label: "d" },
        { id: 2, label: "b" },
        { id: 1, label: "a" },
      ],
      opts,
    );
    expect(ids(container)).toEqual(["4", "2", "1"]);
    expect(container.children[1]).toBe(row2);
    expect(container.children[2]).toBe(row1);
  });

  it("disposes a replaced row before it detaches", () => {
    const container = document.createElement("div");
    reconcileChildren(container, [{ id: 1, label: "a" }], opts);
    const stale = container.children[0]!;
    const disposed: Element[] = [];
    reconcileChildren(container, [{ id: 1, label: "changed" }], {
      ...opts,
      dispose: (el) => disposed.push(el),
    });
    expect(disposed).toEqual([stale]);
    expect(stale.isConnected).toBe(false);
  });

  it("disposes removed rows", () => {
    const container = document.createElement("div");
    reconcileChildren(
      container,
      [
        { id: 1, label: "a" },
        { id: 2, label: "b" },
      ],
      opts,
    );
    const gone = container.children[1];
    const disposed: Element[] = [];
    reconcileChildren(container, [{ id: 1, label: "a" }], {
      ...opts,
      dispose: (el) => disposed.push(el),
    });
    expect(disposed).toEqual([gone]);
  });
});
