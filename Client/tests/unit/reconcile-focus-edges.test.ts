import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconcileChildren,
  reconcileModels,
  sameModel,
  type ModelValue,
  type RowModel,
} from "../../src/lib/reconcile";
import { createElement } from "../../src/lib/dom";

let mounted: HTMLElement[] = [];

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  return container;
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
});

describe("sameModel", () => {
  it("treats NaN as equal to NaN and to nothing else", () => {
    expect(sameModel(Number.NaN, Number.NaN)).toBe(true);
    expect(sameModel(Number.NaN, 1)).toBe(false);
    expect(sameModel(1, Number.NaN)).toBe(false);
    expect(sameModel({ n: Number.NaN }, { n: Number.NaN })).toBe(true);
  });

  it("tells primitives, null, arrays and objects apart", () => {
    expect(sameModel(null, null)).toBe(true);
    expect(sameModel(null, {})).toBe(false);
    expect(sameModel({}, null)).toBe(false);
    expect(sameModel(1, {})).toBe(false);
    expect(sameModel({}, 1)).toBe(false);
    expect(sameModel("a", "b")).toBe(false);
    expect(sameModel("a", "a")).toBe(true);
    expect(sameModel(true, false)).toBe(false);
  });

  it("never mixes an array with an object, even an empty or length-shaped one", () => {
    expect(sameModel([], {})).toBe(false);
    expect(sameModel({}, [])).toBe(false);
    expect(sameModel([], { length: 0 })).toBe(false);
    expect(sameModel({ length: 0 }, [])).toBe(false);
  });

  it("compares arrays element by element", () => {
    expect(sameModel([1, 2], [1, 3])).toBe(false);
    expect(sameModel([1, 2], [2, 2])).toBe(false);
    expect(sameModel([1, 2], [1, 2])).toBe(true);
    expect(sameModel([1, 2, 3], [1, 2])).toBe(false);
  });

  it("compares objects by field names as well as values", () => {
    expect(sameModel({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(sameModel({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("reconcileModels edges", () => {
  interface Item {
    id: string;
    label: string;
    on: boolean;
  }
  type Model = { readonly label: string; readonly on: boolean };
  const baseOpts = (patchApply = vi.fn(), update = vi.fn()) => ({
    key: (i: Item) => i.id,
    model: (i: Item): Model => ({ label: i.label, on: i.on }),
    create: (m: Model) => createElement("div", {}, `${m.label}:${String(m.on)}`),
    patch: { fields: ["on"] as const, apply: patchApply },
    update,
  });

  it("does not patch a row whose model is unchanged, but still lets its container update", () => {
    const apply = vi.fn();
    const update = vi.fn();
    const container = mount();
    const item = { id: "a", label: "x", on: true };
    reconcileModels(container, [item], baseOpts(apply, update));
    expect(update).not.toHaveBeenCalled();
    reconcileModels(container, [{ ...item }], baseOpts(apply, update));
    expect(apply).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);

    reconcileModels(container, [{ ...item, on: false }], baseOpts(apply, update));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toEqual({ label: "x", on: false });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("explains the misuse when a handler reads the live item while its row is being created", () => {
    const container = mount();
    expect(() =>
      reconcileModels(container, [{ id: "a", label: "x", on: true }], {
        key: (i) => i.id,
        model: (i): Model => ({ label: i.label, on: i.on }),
        create: (_m, atEvent) => {
          atEvent();
          return createElement("div");
        },
      }),
    ).toThrow("atEvent called while the row is being created");
  });

  it("rebuilds a row whose model gains a field, patchable or not", () => {
    const container = mount();
    const create = vi.fn(() => createElement("div"));
    const run = (model: RowModel) =>
      reconcileModels(container, ["a"], {
        key: (k) => k,
        model: () => model,
        create,
        patch: { fields: ["on"], apply: vi.fn() },
      });
    run({ label: "x" });
    expect(run({ label: "x", extra: undefined as unknown as ModelValue })).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("lets a signature-driven pass reuse a row built from a model", () => {
    const container = mount();
    reconcileModels(container, ["a"], {
      key: (k) => k,
      model: () => ({ v: 1 }),
      create: () => createElement("div"),
    });
    const row = container.firstElementChild;
    const built = reconcileChildren(container, ["a"], {
      key: (k) => k,
      signature: () => "",
      create: () => createElement("div"),
    });
    expect(built).toBe(0);
    expect(container.firstElementChild).toBe(row);
  });
});

interface Row {
  id: string;
  sig: string;
}

const rowOpts = {
  key: (r: Row) => r.id,
  signature: (r: Row) => r.sig,
  create: (r: Row) => {
    const row = createElement("div", { tabindex: "0", "data-id": r.id });
    row.appendChild(createElement("button", { class: "act" }, r.id));
    return row;
  },
};

const rows = (...specs: string[]): Row[] =>
  specs.map((s) => {
    const [id, sig = "1"] = s.split(":");
    return { id: id!, sig };
  });

const lookAlike = (tag: "span" | "button", cls: string, testid: string): HTMLElement =>
  createElement(tag, { class: cls, "data-testid": testid, tabindex: "0" });

const lookAlikeRow = (r: Row): Element => {
  const row = createElement("div", { class: "row", "data-testid": "k", "data-id": r.id });
  row.append(
    lookAlike("span", "ctl", "k"),
    lookAlike("button", "other", "k"),
    lookAlike("button", "ctl", "other"),
    lookAlike("button", "ctl", "k"),
  );
  return row;
};

const twinButtonsRow = (r: Row): Element => {
  const row = createElement("div", { "data-id": r.id });
  row.append(
    createElement("button", { class: "act", "data-n": "1" }),
    createElement("button", { class: "act", "data-n": "2" }),
  );
  return row;
};

describe("focus through a reconcile pass", () => {
  it("keeps focus on a row that only moves", () => {
    const container = mount();
    reconcileChildren(container, rows("a", "b", "c"), rowOpts);
    const b = container.querySelector<HTMLElement>('[data-id="b"]')!;
    b.focus();
    reconcileChildren(container, rows("b", "c", "a"), rowOpts);
    expect(container.querySelector('[data-id="b"]')).toBe(b);
    expect(document.activeElement).toBe(b);
    reconcileChildren(container, rows("c", "a", "b"), rowOpts);
    expect(document.activeElement).toBe(b);
  });

  it("keeps focus on the very control that held it when its row moves past look-alikes", () => {
    const container = mount();
    const opts = { ...rowOpts, create: twinButtonsRow };
    reconcileChildren(container, rows("a", "b", "c"), opts);
    const second = container.querySelector<HTMLElement>('[data-id="a"] [data-n="2"]')!;
    second.focus();
    reconcileChildren(container, rows("b", "c", "a"), opts);
    expect(document.activeElement).toBe(second);
  });

  it("puts focus on the replacement of a rebuilt row, not on its first sibling", () => {
    const container = mount();
    reconcileChildren(container, rows("a", "b", "c"), rowOpts);
    container.querySelector<HTMLElement>('[data-id="c"] .act')!.focus();
    reconcileChildren(container, rows("a", "b", "c:2"), rowOpts);
    const act = container.querySelector('[data-id="c"] .act');
    expect(act?.isConnected).toBe(true);
    expect(document.activeElement).toBe(act);

    container.querySelector<HTMLElement>('[data-id="b"]')!.focus();
    reconcileChildren(container, rows("a", "b:2", "c:2"), rowOpts);
    expect(document.activeElement).toBe(container.querySelector('[data-id="b"]'));
  });

  it("moves focus to the matching control, skipping look-alikes with another tag, class or test id", () => {
    const container = mount();
    const opts = { ...rowOpts, create: lookAlikeRow };
    reconcileChildren(container, rows("a"), opts);
    const wanted = (): HTMLElement =>
      container.querySelector<HTMLElement>('[data-id="a"] > button.ctl[data-testid="k"]')!;
    wanted().focus();
    reconcileChildren(container, rows("a:2"), opts);
    expect(document.activeElement).toBe(wanted());
  });
});

interface Outer {
  id: string;
  sig: string;
  inner: readonly string[];
}

const reconcileInner = (list: Element, keys: readonly string[]): void => {
  reconcileChildren(list, keys, {
    key: (k) => k,
    signature: (k) => k,
    create: (k) => {
      const row = createElement("div", { class: "inner", tabindex: "0", "data-inner": k });
      row.appendChild(createElement("button", { class: "act" }, k));
      return row;
    },
  });
};

const outerOpts = {
  key: (o: Outer) => o.id,
  signature: (o: Outer) => o.sig,
  create: (o: Outer) => {
    const row = createElement("div", { class: "outer", "data-outer": o.id });
    const list = createElement("div", { class: "list" });
    row.appendChild(list);
    reconcileInner(list, o.inner);
    return row;
  },
};

const outer = (sig: string): Outer => ({ id: "o", sig, inner: ["i1", "i2", "i3"] });

/** An outer row whose list holds "a" (which holds its own "k") and then "k". */
const keyedTwiceRow = (): Element => {
  const row = createElement("div", { class: "outer", "data-outer": "o" });
  const list = createElement("div", { class: "list" });
  row.appendChild(list);
  reconcileChildren(list, ["a", "k"], {
    key: (k) => k,
    signature: (k) => k,
    create: (k) => {
      const inner = createElement("div", { class: "inner", tabindex: "0", "data-path": k });
      if (k === "a") {
        const deeper = createElement("div", { class: "deeper" });
        inner.appendChild(deeper);
        reconcileChildren(deeper, ["k"], {
          key: (d) => d,
          signature: (d) => d,
          create: (d) =>
            createElement("div", { class: "inner", tabindex: "0", "data-path": `a/${d}` }),
        });
      }
      return inner;
    },
  });
  return row;
};

describe("focus through nested rows", () => {
  it("follows a control inside the second inner row, not the first", () => {
    const container = mount();
    reconcileChildren(container, [outer("1")], outerOpts);
    container.querySelector<HTMLElement>('[data-inner="i2"] .act')!.focus();
    reconcileChildren(container, [outer("2")], outerOpts);
    expect(document.activeElement).toBe(container.querySelector('[data-inner="i2"] .act'));
  });

  it("follows an inner row itself, not its outer row or a sibling", () => {
    const container = mount();
    reconcileChildren(container, [outer("1")], outerOpts);
    container.querySelector<HTMLElement>('[data-inner="i3"]')!.focus();
    reconcileChildren(container, [outer("2")], outerOpts);
    expect(document.activeElement).toBe(container.querySelector('[data-inner="i3"]'));
  });

  it("matches a key only among the rows directly below the outer row", () => {
    const container = mount();
    const opts = {
      key: (o: { id: string }) => o.id,
      signature: (o: { sig: string }) => o.sig,
      create: keyedTwiceRow,
    };
    reconcileChildren(container, [{ id: "o", sig: "1" }], opts);
    container.querySelector<HTMLElement>('[data-path="k"]')!.focus();
    reconcileChildren(container, [{ id: "o", sig: "2" }], opts);
    expect(document.activeElement).toBe(container.querySelector('[data-path="k"]'));
    expect(document.activeElement).not.toBe(container.querySelector('[data-path="a/k"]'));
  });
});

interface Group {
  id: string;
  sig: string;
  users: readonly string[];
}

/** A group row holding one channel row "x", which holds focusable user rows. */
const groupWithChannel = (g: Group): Element => {
  const group = createElement("div", { class: "group", "data-group": g.id });
  const channels = createElement("div", { class: "channels" });
  group.appendChild(channels);
  reconcileChildren(channels, ["x"], {
    key: (k) => k,
    signature: (k) => k,
    create: (k) => {
      const channel = createElement("div", { class: "channel", "data-channel": k });
      const users = createElement("div", { class: "users" });
      channel.appendChild(users);
      reconcileChildren(users, g.users, {
        key: (u) => u,
        signature: (u) => u,
        create: (u) => createElement("div", { class: "user", tabindex: "0", "data-user": u }),
      });
      return channel;
    },
  });
  return group;
};

describe("focus when the key path breaks", () => {
  it("lands on a look-alike row inside the deepest row that still matches", () => {
    const container = mount();
    const opts = {
      key: (g: Group) => g.id,
      signature: (g: Group) => g.sig,
      create: groupWithChannel,
    };
    reconcileChildren(container, [{ id: "g", sig: "1", users: ["u1", "u2"] }], opts);
    container.querySelector<HTMLElement>('[data-user="u1"]')!.focus();
    reconcileChildren(container, [{ id: "g", sig: "2", users: ["u2"] }], opts);
    expect(document.activeElement).toBe(container.querySelector('[data-user="u2"]'));
  });
});
