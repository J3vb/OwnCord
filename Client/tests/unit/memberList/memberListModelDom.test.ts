import { afterEach, describe, expect, it, vi } from "vitest";
import { firstRowInView, scrollParentOf } from "../../../src/features/members/memberListModel";

// jsdom lays nothing out: each box, client size and computed style is stubbed.

function box(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function place(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () => box(top, height);
}

function client(el: HTMLElement, clientTop: number, clientHeight: number): void {
  Object.defineProperty(el, "clientTop", { configurable: true, value: clientTop });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

/** Computed styles by element; anything not listed reads as jsdom's own. */
function styles(map: Map<Element, Partial<CSSStyleDeclaration>>): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
    const own = map.get(el);
    return own === undefined ? real(el) : ({ ...own } as CSSStyleDeclaration);
  });
}

/** A scroller at top 100, 200 tall with a 2 px border, and rows of 20 px from `tops`. */
function column(tops: readonly number[]): {
  scroller: HTMLElement;
  root: HTMLElement;
  rows: HTMLElement[];
} {
  const scroller = document.createElement("div");
  const root = document.createElement("div");
  scroller.appendChild(root);
  document.body.appendChild(scroller);
  place(scroller, 100, 204);
  client(scroller, 2, 200);
  const header = document.createElement("div");
  header.className = "member-role-group";
  root.appendChild(header);
  const rows = tops.map((top, i) => {
    const row = document.createElement("div");
    row.className = "member-item";
    row.id = `row-${i}`;
    place(row, top, 20);
    root.appendChild(row);
    return row;
  });
  return { scroller, root, rows };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("firstRowInView", () => {
  it("with no scroller, is the first row", () => {
    const { root, rows } = column([0, 20]);
    expect(firstRowInView(root, null)).toBe(rows[0]);
  });

  it("with no rows, is null", () => {
    const { root, scroller } = column([]);
    styles(new Map([[scroller, { scrollPaddingTop: "0px", scrollPaddingBottom: "0px" }]]));
    expect(firstRowInView(root, scroller)).toBeNull();
  });

  it("skips rows above the view and is the first one fully inside", () => {
    // The view is 102..302 (the scroller's top plus its border).
    const { root, scroller, rows } = column([60, 90, 101, 102, 130]);
    styles(new Map([[scroller, { scrollPaddingTop: "0px", scrollPaddingBottom: "0px" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[3]);
  });

  it("starts the view below the scroll padding", () => {
    const { root, scroller, rows } = column([102, 140, 150]);
    styles(new Map([[scroller, { scrollPaddingTop: "48px", scrollPaddingBottom: "0px" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[2]);
  });

  it("ends the view above the bottom scroll padding", () => {
    // The view is 102..302, less 30 at the bottom: a row from 250 to 270 fits, one from 255 does not.
    const { root, scroller, rows } = column([40, 255, 250]);
    styles(new Map([[scroller, { scrollPaddingTop: "0px", scrollPaddingBottom: "30px" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[2]);
  });

  it("a row reaching past the bottom does not count, so the first row is the fallback", () => {
    const { root, scroller, rows } = column([10, 290]);
    styles(new Map([[scroller, { scrollPaddingTop: "0px", scrollPaddingBottom: "0px" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[0]);
  });

  it("a row ending exactly on the bottom edge counts", () => {
    const { root, scroller, rows } = column([10, 282]);
    styles(new Map([[scroller, { scrollPaddingTop: "0px", scrollPaddingBottom: "0px" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[1]);
  });

  it("reads an unset scroll padding as zero", () => {
    const { root, scroller, rows } = column([50, 102, 282]);
    styles(new Map([[scroller, { scrollPaddingTop: "auto", scrollPaddingBottom: "" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[1]);
  });

  it("an unset bottom padding keeps the view's full height", () => {
    const { root, scroller, rows } = column([10, 282]);
    styles(new Map([[scroller, { scrollPaddingTop: "0px", scrollPaddingBottom: "auto" }]]));
    expect(firstRowInView(root, scroller)).toBe(rows[1]);
  });
});

function chain(): { outer: HTMLElement; middle: HTMLElement; inner: HTMLElement } {
  const outer = document.createElement("div");
  const middle = document.createElement("div");
  const inner = document.createElement("div");
  outer.appendChild(middle);
  middle.appendChild(inner);
  document.body.appendChild(outer);
  return { outer, middle, inner };
}

describe("scrollParentOf", () => {
  it("is the nearest ancestor whose overflow-y is auto", () => {
    const { outer, middle, inner } = chain();
    styles(
      new Map<Element, Partial<CSSStyleDeclaration>>([
        [outer, { overflowY: "scroll" }],
        [middle, { overflowY: "auto" }],
      ]),
    );
    expect(scrollParentOf(inner)).toBe(middle);
  });

  it("passes over hidden and visible overflow to a scroll ancestor", () => {
    const { outer, middle, inner } = chain();
    styles(
      new Map<Element, Partial<CSSStyleDeclaration>>([
        [outer, { overflowY: "scroll" }],
        [middle, { overflowY: "hidden" }],
      ]),
    );
    expect(scrollParentOf(inner)).toBe(outer);
  });

  it("never returns the element itself", () => {
    const { middle } = chain();
    styles(new Map<Element, Partial<CSSStyleDeclaration>>([[middle, { overflowY: "auto" }]]));
    expect(scrollParentOf(middle)).toBeNull();
  });

  it("is null when nothing scrolls, or with no parent", () => {
    const { inner } = chain();
    expect(scrollParentOf(inner)).toBeNull();
    expect(scrollParentOf(document.createElement("div"))).toBeNull();
  });
});
