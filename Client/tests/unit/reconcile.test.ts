import { describe, it, expect } from "vitest";
import { reconcileChildren, reconcileModels, sameModel } from "../../src/lib/net/reconcile";
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

const abcItems = () => [
  { id: 1, label: "a" },
  { id: 2, label: "b" },
  { id: 3, label: "c" },
];

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
    reconcileChildren(container, abcItems(), opts);
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
    reconcileChildren(container, abcItems(), opts);
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

  it("moves focus from a control inside a replaced row to the same control in its replacement", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const nestedOpts = {
      ...opts,
      create: (r: Row) => {
        const row = createElement("div", { "data-id": String(r.id) }, r.label);
        row.appendChild(createElement("button", { class: "row-action" }));
        return row;
      },
    };
    reconcileChildren(container, [{ id: 1, label: "a" }], nestedOpts);
    (container.querySelector(".row-action") as HTMLElement).focus();

    reconcileChildren(container, [{ id: 1, label: "changed" }], nestedOpts);

    expect(document.activeElement).toBe(container.querySelector(".row-action"));
    container.remove();
  });

  it("moves only the nodes outside the longest kept run", () => {
    const container = document.createElement("div");
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, label: String(i) }));
    reconcileChildren(container, items, opts);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(container, { childList: true });

    reconcileChildren(container, [...items.slice(1), items[0]!], opts);
    records.push(...observer.takeRecords());
    observer.disconnect();

    const moves = records.reduce((n, r) => n + r.addedNodes.length, 0);
    expect(moves).toBe(1);
    expect(ids(container)).toEqual([...items.slice(1), items[0]!].map((r) => String(r.id)));
  });

  it("order matches wanted for random permutations", () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const container = document.createElement("div");
    let current = Array.from({ length: 30 }, (_, i) => i);
    reconcileChildren(
      container,
      current.map((id) => ({ id, label: String(id) })),
      opts,
    );
    for (let round = 0; round < 200; round++) {
      const next = current.filter(() => rand() > 0.15);
      const inserts = Math.floor(rand() * 4);
      for (let id = 1000 + 100 * round; id < 1000 + 100 * round + inserts; id++) {
        next.splice(Math.floor(rand() * (next.length + 1)), 0, id);
      }
      for (let i = next.length - 1; i > 0; i--) {
        if (rand() < 0.3) {
          const j = Math.floor(rand() * (i + 1));
          [next[i], next[j]] = [next[j]!, next[i]!];
        }
      }
      const unique = [...new Set(next)];
      reconcileChildren(
        container,
        unique.map((id) => ({ id, label: String(id) })),
        opts,
      );
      expect(ids(container)).toEqual(unique.map(String));
      current = unique;
    }
  });
});

describe("sameModel", () => {
  it("compares nested plain data structurally and ignores key order", () => {
    expect(sameModel({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(sameModel({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameModel([1, 2], [1, 2, 3])).toBe(false);
    expect(sameModel([], {})).toBe(false);
    expect(sameModel(null, {})).toBe(false);
  });
});

describe("model rows", () => {
  type Model = { readonly id: number; readonly label: string; readonly status: string };
  interface Item {
    id: number;
    label: string;
    status: string;
  }
  const modelOpts = {
    key: (i: Item) => String(i.id),
    model: (i: Item): Model => ({ id: i.id, label: i.label, status: i.status }),
    create: (m: Model) =>
      createElement("div", { "data-id": String(m.id) }, `${m.label}/${m.status}`),
    patch: {
      fields: ["status"] as const,
      apply: (el: Element, next: Model) => {
        el.textContent = `${next.label}/${next.status}`;
      },
    },
  };

  it("equal model reuses node", () => {
    const container = document.createElement("div");
    const items = [{ id: 1, label: "a", status: "on" }];
    reconcileModels(container, items, modelOpts);
    const before = container.firstElementChild;
    expect(reconcileModels(container, [{ ...items[0]! }], modelOpts)).toBe(0);
    expect(container.firstElementChild).toBe(before);
  });

  it("patch-only diff patches, keeps node", () => {
    const container = document.createElement("div");
    reconcileModels(container, [{ id: 1, label: "a", status: "on" }], modelOpts);
    const before = container.firstElementChild;
    const built = reconcileModels(container, [{ id: 1, label: "a", status: "off" }], modelOpts);
    expect(built).toBe(0);
    expect(container.firstElementChild).toBe(before);
    expect(before?.textContent).toBe("a/off");
    // The patched model is the new baseline: going back is a patch again.
    expect(reconcileModels(container, [{ id: 1, label: "a", status: "on" }], modelOpts)).toBe(0);
    expect(before?.textContent).toBe("a/on");
  });

  it("non-patch diff rebuilds", () => {
    const container = document.createElement("div");
    reconcileModels(container, [{ id: 1, label: "a", status: "on" }], modelOpts);
    const before = container.firstElementChild;
    const built = reconcileModels(container, [{ id: 1, label: "b", status: "off" }], modelOpts);
    expect(built).toBe(1);
    expect(container.firstElementChild).not.toBe(before);
    expect(container.textContent).toBe("b/off");
  });

  it("atEvent returns the live item and throws during create", () => {
    const container = document.createElement("div");
    let read: (() => Item) | undefined;
    let duringCreate: unknown;
    const withRef = {
      ...modelOpts,
      create: (m: Model, atEvent: () => Item) => {
        try {
          atEvent();
        } catch (e) {
          duringCreate = e;
        }
        read = atEvent;
        return modelOpts.create(m);
      },
    };
    reconcileModels(container, [{ id: 1, label: "a", status: "on" }], withRef);
    expect(duringCreate).toBeInstanceOf(Error);
    const next = { id: 1, label: "a", status: "off" };
    reconcileModels(container, [next], withRef);
    expect(read?.()).toBe(next);
  });

  it("moves and removes rows like reconcileChildren", () => {
    const container = document.createElement("div");
    const mk = (id: number): Item => ({ id, label: String(id), status: "on" });
    reconcileModels(container, [mk(1), mk(2), mk(3)], modelOpts);
    const two = container.children[1];
    reconcileModels(container, [mk(3), mk(2)], modelOpts);
    expect(ids(container)).toEqual(["3", "2"]);
    expect(container.children[1]).toBe(two);
  });
});

describe("nested rows", () => {
  type UserModel = { readonly name: string };
  /** Reconcile user rows into `list`; each row is focusable and holds one button. */
  function reconcileUsers(list: Element, users: readonly string[]): void {
    reconcileModels(list, users, {
      key: (u) => u,
      model: (u): UserModel => ({ name: u }),
      create: (m) => {
        const row = createElement("div", { class: "user", tabindex: "0", "data-id": m.name });
        row.appendChild(createElement("button", { class: "act" }, m.name));
        return row;
      },
    });
  }

  interface Outer {
    id: string;
    label: string;
    users: readonly string[];
  }
  /** An outer row whose create builds its nested user rows itself. */
  const outerOpts = {
    key: (o: Outer) => o.id,
    signature: (o: Outer) => o.label,
    create: (o: Outer) => {
      const wrapper = createElement("div", { "data-id": o.id });
      const list = createElement("div", { class: "list" });
      wrapper.appendChild(list);
      reconcileUsers(list, o.users);
      return wrapper;
    },
    update: (el: Element, o: Outer) => reconcileUsers(el.querySelector(".list")!, o.users),
  };

  it("nested row focus follows key path", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    reconcileChildren(container, [{ id: "ch", label: "a", users: ["B", "C"] }], outerOpts);
    (container.querySelector('[data-id="B"]') as HTMLElement).focus();

    // The outer signature changes (a rebuild) and the inner order becomes C, B.
    reconcileChildren(container, [{ id: "ch", label: "renamed", users: ["C", "B"] }], outerOpts);

    const b = container.querySelector('[data-id="B"]');
    expect(b?.isConnected).toBe(true);
    expect(document.activeElement).toBe(b);
    container.remove();
  });

  it("a control inside a nested row keeps focus through the key path", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    reconcileChildren(container, [{ id: "ch", label: "a", users: ["B", "C"] }], outerOpts);
    (container.querySelector('[data-id="B"] .act') as HTMLElement).focus();

    reconcileChildren(container, [{ id: "ch", label: "renamed", users: ["C", "B"] }], outerOpts);

    expect(document.activeElement).toBe(container.querySelector('[data-id="B"] .act'));
    container.remove();
  });

  it("a broken key path falls back to the same() control in the deepest match", () => {
    interface Channel {
      id: string;
      users: readonly string[];
    }
    interface Group {
      id: string;
      label: string;
      channels: readonly Channel[];
    }
    type ChannelModel = { readonly id: string; readonly users: readonly string[] };
    const reconcileChannels = (list: Element, channels: readonly Channel[]): void => {
      reconcileModels(list, channels, {
        key: (c) => c.id,
        model: (c): ChannelModel => ({ id: c.id, users: [...c.users] }),
        create: (m) => {
          const wrapper = createElement("div", { class: "channel", "data-id": m.id });
          const users = createElement("div", { class: "list" });
          wrapper.appendChild(users);
          reconcileUsers(users, m.users);
          return wrapper;
        },
      });
    };
    const groupOpts = {
      key: (g: Group) => g.id,
      signature: (g: Group) => g.label,
      create: (g: Group) => {
        const group = createElement("div", { "data-id": g.id });
        const list = createElement("div", { class: "channels" });
        group.appendChild(list);
        reconcileChannels(list, g.channels);
        return group;
      },
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    reconcileChildren(
      container,
      [
        {
          id: "g",
          label: "a",
          channels: [
            { id: "x", users: ["u1"] },
            { id: "y", users: ["u2"] },
          ],
        },
      ],
      groupOpts,
    );
    (container.querySelector('[data-id="u2"] .act') as HTMLElement).focus();

    // The group rebuilds; channel y survives but its focused user is gone.
    reconcileChildren(
      container,
      [
        {
          id: "g",
          label: "renamed",
          channels: [
            { id: "x", users: ["u1"] },
            { id: "y", users: ["u3"] },
          ],
        },
      ],
      groupOpts,
    );

    // The same control inside y, the deepest row the path still matched.
    expect(document.activeElement).toBe(container.querySelector('[data-id="u3"] .act'));
    container.remove();
  });
});
