import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScrollWatch,
  type ScrollWatch,
} from "../../../src/features/members/memberListScroll";

/** A ResizeObserver that records what it watches; `report` plays an entry. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly watched = new Set<Element>();
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.watched.add(el);
  }
  unobserve(el: Element): void {
    this.watched.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.watched.clear();
  }
  report(...sized: [Element, number, number][]): void {
    const entries = sized.map(
      ([target, width, height]) =>
        ({ target, contentRect: { width, height } }) as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

const observer = (): FakeObserver => {
  expect(FakeObserver.all).toHaveLength(1);
  return FakeObserver.all[0]!;
};

function scrollBox(): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  return el;
}

let onChange: ReturnType<typeof vi.fn<() => void>>;
let watch: ScrollWatch;

beforeEach(() => {
  FakeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeObserver);
  onChange = vi.fn<() => void>();
  watch = createScrollWatch(onChange);
});

afterEach(() => {
  watch.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("createScrollWatch: bind", () => {
  it("watches the nearest scrolling ancestor and reports its scrolls", () => {
    const scroller = scrollBox();
    const root = document.createElement("div");
    scroller.appendChild(root);
    document.body.appendChild(scroller);

    watch.bind(root);

    expect(watch.scroller()).toBe(scroller);
    expect([...observer().watched]).toEqual([scroller]);
    scroller.dispatchEvent(new Event("scroll"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("watches the root itself until it has a scroller, then swaps to the scroller", () => {
    const root = document.createElement("div");
    watch.bind(root);
    expect(watch.scroller()).toBeNull();
    expect([...observer().watched]).toEqual([root]);

    const scroller = scrollBox();
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    watch.bind(root);

    expect(watch.scroller()).toBe(scroller);
    expect([...observer().watched]).toEqual([scroller]);
  });

  it("keeps the scroller while it still holds the root", () => {
    const outer = scrollBox();
    const scroller = scrollBox();
    const root = document.createElement("div");
    outer.appendChild(scroller);
    scroller.appendChild(root);
    document.body.appendChild(outer);
    watch.bind(root);
    // The root's nearest scroller stops scrolling, but still holds it.
    scroller.style.overflowY = "visible";
    watch.bind(root);
    expect(watch.scroller()).toBe(scroller);
    expect(FakeObserver.all).toHaveLength(1);
  });

  it("moves to a new scroller when the root is moved, and drops the old one's listener", () => {
    const first = scrollBox();
    const second = scrollBox();
    const root = document.createElement("div");
    first.appendChild(root);
    document.body.append(first, second);
    watch.bind(root);

    second.appendChild(root);
    watch.bind(root);

    expect(watch.scroller()).toBe(second);
    expect([...observer().watched]).toEqual([second]);
    first.dispatchEvent(new Event("scroll"));
    expect(onChange).not.toHaveBeenCalled();
    second.dispatchEvent(new Event("scroll"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("goes back to watching the root when it leaves every scroller", () => {
    const scroller = scrollBox();
    const root = document.createElement("div");
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    watch.bind(root);

    root.remove();
    watch.bind(root);

    expect(watch.scroller()).toBeNull();
    expect([...observer().watched]).toEqual([root]);
    scroller.dispatchEvent(new Event("scroll"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works with no ResizeObserver at all", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const scroller = scrollBox();
    const root = document.createElement("div");
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    watch.bind(root);
    expect(watch.scroller()).toBe(scroller);
    scroller.dispatchEvent(new Event("scroll"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

function bound(): { scroller: HTMLElement; root: HTMLElement } {
  const scroller = scrollBox();
  const root = document.createElement("div");
  scroller.appendChild(root);
  document.body.appendChild(scroller);
  watch.bind(root);
  return { scroller, root };
}

describe("createScrollWatch: resize reports", () => {
  it("a scroller's first size reports, and the same size again does not", () => {
    const { scroller } = bound();
    observer().report([scroller, 240, 500]);
    expect(onChange).toHaveBeenCalledTimes(1);
    observer().report([scroller, 240, 500]);
    expect(onChange).toHaveBeenCalledTimes(1);
    observer().report([scroller, 240, 400]);
    expect(onChange).toHaveBeenCalledTimes(2);
    observer().report([scroller, 200, 400]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("a watched root's first size reports", () => {
    const root = document.createElement("div");
    watch.bind(root);
    observer().report([root, 240, 0]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a sample's first size is only its start; a later change reports", () => {
    const { root } = bound();
    const row = document.createElement("div");
    root.appendChild(row);
    watch.sample(root, new WeakMap([[row, 1]]));
    observer().report([row, 200, 42]);
    expect(onChange).not.toHaveBeenCalled();
    observer().report([row, 200, 45]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("one call for a batch with several changes", () => {
    const { scroller, root } = bound();
    const row = document.createElement("div");
    root.appendChild(row);
    watch.sample(root, new WeakMap([[row, 1]]));
    observer().report([row, 200, 42]);
    observer().report([scroller, 240, 500], [row, 200, 50]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

function kinds(
  root: HTMLElement,
  list: readonly number[],
): {
  els: HTMLElement[];
  kindByEl: WeakMap<Element, number>;
} {
  const kindByEl = new WeakMap<Element, number>();
  const els = list.map((kind) => {
    const el = document.createElement("div");
    root.appendChild(el);
    if (kind >= 0) kindByEl.set(el, kind);
    return el;
  });
  return { els, kindByEl };
}

describe("createScrollWatch: sample", () => {
  it("watches the first child of each kind, and children with no kind not at all", () => {
    const scroller = scrollBox();
    const root = document.createElement("div");
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    watch.bind(root);
    const { els, kindByEl } = kinds(root, [-1, 0, 1, 1, 2, 0, 3]);

    watch.sample(root, kindByEl);

    expect(observer().watched).toEqual(new Set([scroller, els[1], els[2], els[4], els[6]]));
  });

  it("swaps a sample whose row left for the next one of its kind, and leaves the rest", () => {
    const root = document.createElement("div");
    watch.bind(root);
    const { els, kindByEl } = kinds(root, [0, 1, 1]);
    watch.sample(root, kindByEl);
    const before = new Set(observer().watched);
    expect(before).toEqual(new Set([root, els[0], els[1]]));

    els[1]!.remove();
    watch.sample(root, kindByEl);

    expect(observer().watched).toEqual(new Set([root, els[0], els[2]]));
  });

  it("stops watching a kind with no row left", () => {
    const root = document.createElement("div");
    watch.bind(root);
    const { els, kindByEl } = kinds(root, [0, 1]);
    watch.sample(root, kindByEl);
    els[0]!.remove();
    watch.sample(root, kindByEl);
    expect(observer().watched).toEqual(new Set([root, els[1]]));
  });
});

describe("createScrollWatch: destroy", () => {
  it("disconnects the observer, drops the scroll listener and forgets the scroller", () => {
    const scroller = scrollBox();
    const root = document.createElement("div");
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    watch.bind(root);
    const ro = observer();

    watch.destroy();

    expect(ro.disconnected).toBe(true);
    expect(watch.scroller()).toBeNull();
    scroller.dispatchEvent(new Event("scroll"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is safe before any bind, and a later bind starts a new observer", () => {
    watch.destroy();
    const root = document.createElement("div");
    watch.bind(root);
    expect(FakeObserver.all).toHaveLength(1);
    expect([...FakeObserver.all[0]!.watched]).toEqual([root]);
  });

  it("a sample after destroy and a new bind watches its rows again", () => {
    const root = document.createElement("div");
    watch.bind(root);
    const row = document.createElement("div");
    root.appendChild(row);
    const kindByEl = new WeakMap([[row, 1]]);
    watch.sample(root, kindByEl);
    watch.destroy();
    watch.bind(root);
    watch.sample(root, kindByEl);
    expect(FakeObserver.all[1]!.watched).toEqual(new Set([root, row]));
  });
});
