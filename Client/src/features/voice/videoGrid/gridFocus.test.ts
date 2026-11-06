import { describe, expect, it } from "vitest";
import { fillThumbStrip, seatFocusedTile } from "./gridFocus";
import type { GridState } from "@components/video-grid/gridState";

function stateWith(ids: number[]): { st: GridState; els: Map<number, HTMLDivElement> } {
  const els = new Map<number, HTMLDivElement>();
  const cells = new Map<number, { el: HTMLDivElement }>();
  for (const id of ids) {
    const el = document.createElement("div");
    els.set(id, el);
    cells.set(id, { el });
  }
  return { st: { cells } as unknown as GridState, els };
}

describe("gridFocus", () => {
  it("seats the focused tile in the main area", () => {
    const { st, els } = stateWith([1]);
    const main = document.createElement("div");
    els.get(1)?.classList.add("thumb");
    seatFocusedTile(st, main, 1);
    expect(main.firstChild).toBe(els.get(1));
    expect(els.get(1)?.classList.contains("focused")).toBe(true);
    expect(els.get(1)?.classList.contains("thumb")).toBe(false);
  });

  it("empties the main area when the focused tile is gone", () => {
    const { st } = stateWith([]);
    const main = document.createElement("div");
    main.appendChild(document.createElement("span"));
    seatFocusedTile(st, main, 9);
    expect(main.childNodes.length).toBe(0);
  });

  it("moves the other streams and the avatar tiles into the strip", () => {
    const { st, els } = stateWith([1, 2]);
    const avatar = document.createElement("div");
    avatar.className = "video-cell--avatar";
    const plain = document.createElement("div");
    const strip = document.createElement("div");
    els.get(2)?.classList.add("focused");
    fillThumbStrip(st, strip, 1, [avatar, plain]);
    expect([...strip.children]).toEqual([els.get(2), avatar]);
    expect(els.get(2)?.classList.contains("thumb")).toBe(true);
    expect(els.get(2)?.classList.contains("focused")).toBe(false);
  });
});
