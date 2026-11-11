import { describe, expect, it } from "vitest";
import type { GridState } from "./gridState";
import { drawSmallInFocus, enterFocus, keepChoiceThroughFocus, leaveFocus } from "./tileFocus";

function stateWith(ids: number[]): GridState {
  return {
    cells: new Map(ids.map((id) => [id, {}])),
    tileSizes: new Map(),
    pinned: new Set<number>(),
    focusedTileId: null,
    focusSaved: null,
  } as unknown as GridState;
}

describe("tileFocus", () => {
  it("pins the tile and draws the others Small", () => {
    const st = stateWith([1, 2, 3]);
    enterFocus(st, 2);
    expect(st.focusedTileId).toBe(2);
    expect([...st.pinned]).toEqual([2]);
    expect([...st.tileSizes]).toEqual([
      [1, "small"],
      [3, "small"],
    ]);
  });

  it("gives back the sizes and pins from before, dropping tiles that are gone", () => {
    const st = stateWith([1, 2, 3]);
    st.tileSizes.set(1, "large");
    st.tileSizes.set(3, "medium");
    st.pinned.add(3);
    enterFocus(st, 2);
    st.cells.delete(3);

    leaveFocus(st);

    expect(st.focusedTileId).toBeNull();
    expect(st.focusSaved).toBeNull();
    expect([...st.tileSizes]).toEqual([[1, "large"]]);
    expect([...st.pinned]).toEqual([]);
  });

  it("moves focus to another tile without losing the first arrangement", () => {
    const st = stateWith([1, 2]);
    st.tileSizes.set(2, "large");
    enterFocus(st, 1);
    enterFocus(st, 2);
    expect([...st.pinned]).toEqual([2]);
    expect(st.tileSizes.get(1)).toBe("small");
    leaveFocus(st);
    expect([...st.tileSizes]).toEqual([[2, "large"]]);
  });

  it("is a no-op to enter the same tile twice, and to leave without focus", () => {
    const st = stateWith([1, 2]);
    leaveFocus(st);
    enterFocus(st, 1);
    const saved = st.focusSaved;
    enterFocus(st, 1);
    expect(st.focusSaved).toBe(saved);
  });

  it("draws a late tile Small, and keeps a choice made on another tile", () => {
    const st = stateWith([1, 2]);
    drawSmallInFocus(st, 5);
    expect(st.tileSizes.has(5)).toBe(false);
    enterFocus(st, 1);
    st.cells.set(5, {} as never);
    drawSmallInFocus(st, 5);
    expect(st.tileSizes.get(5)).toBe("small");

    st.tileSizes.set(2, "large");
    keepChoiceThroughFocus(st, 2);
    leaveFocus(st);
    expect(st.tileSizes.get(2)).toBe("large");
    expect(st.tileSizes.has(5)).toBe(false);
  });
});
