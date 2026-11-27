/**
 * The tab row's drag rules: drop zones by X, the "+N" drop that sends an item
 * to the end, and drops that must commit nothing. jsdom has no DragEvent and
 * lays nothing out, so drag events are MouseEvents with a clientX and each
 * target's rect is stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRailDrag, type RailDrag } from "../../../src/features/server-rail/railDrag";
import type { RailMutations } from "../../../src/features/server-rail/serverRailMenus";
import { wireMoreDrop, wireTabDrag, zoneOfX } from "../../../src/features/server-rail/tabDrag";
import type { RailLayout } from "@lib/prefs/serverRailLayout";

const LEFT = 100;
const WIDTH = 100;

function at(type: string, x: number): DragEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
  }) as unknown as DragEvent;
}

function fire(el: Element, type: string, x = LEFT + WIDTH / 2): void {
  el.dispatchEvent(at(type, x));
}

function boxed(width = WIDTH): HTMLElement {
  const el = document.createElement("button");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(LEFT, 0, width, 30));
  return el;
}

const A = "a.example";
const B = "b.example";
const C = "c.example";
const LAYOUT: RailLayout = [
  { kind: "server", host: A },
  { kind: "server", host: B },
  { kind: "server", host: C },
];

interface Rig {
  readonly root: HTMLElement;
  readonly track: HTMLElement;
  readonly tab: (host: string) => HTMLElement;
  readonly more: HTMLElement;
  readonly commit: ReturnType<typeof vi.fn<(next: RailLayout) => void>>;
}

/** A nav (the drag's root) holding a track of server tabs and "+N". */
function rig(layout: RailLayout = LAYOUT): Rig {
  let state = layout;
  const commit = vi.fn<(next: RailLayout) => void>((next) => {
    state = next;
  });
  const mutations: RailMutations = {
    reconciled: () => state,
    commit,
    newFolderId: () => "fid",
    promptRename: () => {},
  };
  const drag = createRailDrag(mutations);
  const root = document.createElement("nav");
  const track = document.createElement("div");
  root.appendChild(track);
  drag.root(root);
  const tabs = new Map<string, HTMLElement>();
  for (const item of layout) {
    if (item.kind !== "server") continue;
    const el = boxed();
    el.dataset["host"] = item.host;
    wireTabDrag(drag, el, item);
    tabs.set(item.host, el);
    track.appendChild(el);
  }
  const more = boxed(40);
  wireMoreDrop(drag, more, layout);
  track.appendChild(more);
  document.body.appendChild(root);
  const tab = (host: string): HTMLElement => {
    const el = tabs.get(host);
    if (el === undefined) throw new Error(`no tab ${host}`);
    return el;
  };
  return { root, track, tab, more, commit };
}

const markers = (root: Element): number =>
  root.querySelectorAll(".drop-before, .drop-after, .drop-into").length;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("zoneOfX", () => {
  it("x zones split 25/50/25 with into, else halves", () => {
    const el = boxed();
    expect(zoneOfX(at("dragover", LEFT + 10), el, true)).toBe("before");
    expect(zoneOfX(at("dragover", LEFT + 24), el, true)).toBe("before");
    expect(zoneOfX(at("dragover", LEFT + 26), el, true)).toBe("into");
    expect(zoneOfX(at("dragover", LEFT + 74), el, true)).toBe("into");
    expect(zoneOfX(at("dragover", LEFT + 76), el, true)).toBe("after");
    expect(zoneOfX(at("dragover", LEFT + 49), el, false)).toBe("before");
    expect(zoneOfX(at("dragover", LEFT + 51), el, false)).toBe("after");
  });

  it("width 0 gives after, never into", () => {
    const el = boxed(0);
    for (const x of [0, LEFT, LEFT + 50, 1000]) {
      expect(zoneOfX(at("drop", x), el, true)).toBe("after");
      expect(zoneOfX(at("drop", x), el, false)).toBe("after");
    }
  });
});

describe("wireTabDrag and wireMoreDrop", () => {
  it("a tab is a drag source and a drop target by X: a centre drop on a server makes a folder", () => {
    const r = rig();
    expect(r.tab(A).draggable).toBe(true);
    fire(r.tab(A), "dragstart");
    fire(r.tab(B), "dragover", LEFT + 50);
    expect(r.tab(B).classList.contains("drop-into")).toBe(true);
    fire(r.tab(B), "drop", LEFT + 50);
    expect(r.commit).toHaveBeenCalledTimes(1);
    expect(r.commit.mock.calls[0]![0]).toMatchObject([
      { kind: "folder", id: "fid", hosts: [B, A] },
      { kind: "server", host: C },
    ]);
    expect(markers(r.root)).toBe(0);
  });

  it("a drop on +N moves the item to the end, and dropping the last item there changes nothing", () => {
    const r = rig();
    expect(r.more.draggable).toBe(false);
    fire(r.tab(A), "dragstart");
    fire(r.more, "dragover", LEFT + 1);
    expect(r.more.classList.contains("drop-after")).toBe(true);
    fire(r.more, "drop", LEFT + 1);
    expect(r.commit).toHaveBeenCalledExactlyOnceWith([
      { kind: "server", host: B },
      { kind: "server", host: C },
      { kind: "server", host: A },
    ]);
    expect(markers(r.root)).toBe(0);

    r.commit.mockClear();
    fire(r.tab(C), "dragstart");
    fire(r.more, "dragover");
    fire(r.more, "drop");
    fire(r.tab(C), "dragend");
    expect(r.commit).not.toHaveBeenCalled();
    expect(markers(r.root)).toBe(0);
  });

  it("wireMoreDrop on an empty layout does nothing", () => {
    const target = vi.fn();
    const drag: RailDrag = { source: vi.fn(), target, root: vi.fn() };
    const more = boxed(40);
    wireMoreDrop(drag, more, []);
    expect(target).not.toHaveBeenCalled();
    expect(more.draggable).toBe(false);
  });

  it("a drop on its own tab or between tabs commits nothing and clears every marker", () => {
    const r = rig();
    fire(r.tab(A), "dragstart");
    fire(r.tab(B), "dragover", LEFT + 10);
    expect(markers(r.root)).toBe(1);
    fire(r.tab(A), "dragover", LEFT + 10);
    fire(r.tab(A), "drop", LEFT + 10);
    fire(r.tab(A), "dragend");
    expect(r.commit).not.toHaveBeenCalled();
    expect(markers(r.root)).toBe(0);

    // In the gap: the track itself is no target, so the root catches the drop.
    fire(r.tab(A), "dragstart");
    fire(r.tab(B), "dragover", LEFT + 90);
    expect(r.tab(B).classList.contains("drop-after")).toBe(true);
    fire(r.track, "dragover");
    fire(r.track, "drop");
    fire(r.tab(A), "dragend");
    expect(r.commit).not.toHaveBeenCalled();
    expect(markers(r.root)).toBe(0);
  });

  it("a drop on a target removed during dispatch commits nothing and clears every marker", () => {
    const r = rig();
    const b = r.tab(B);
    fire(r.tab(A), "dragstart");
    fire(b, "dragover", LEFT + 10);
    expect(b.classList.contains("drop-before")).toBe(true);
    // A rebuild running ahead of the tab's own handler removes the tab.
    r.root.addEventListener("drop", () => b.remove(), { capture: true, once: true });
    fire(b, "drop", LEFT + 10);
    expect(b.isConnected).toBe(false);
    expect(r.commit).not.toHaveBeenCalled();
    expect(markers(r.root)).toBe(0);
    expect(b.className).toBe("");
  });
});
