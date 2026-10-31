/**
 * Cross-category drag (WP 6.5c): a channel dropped on a row of another
 * category, on a category header or in the uncategorized area, and a category
 * header dragged to reorder the categories. The DOM is the sidebar's own shape
 * (`.channel-list` > group > `.category` header + `.category-channels-container`),
 * with stubbed geometry because jsdom does not lay out.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  attachCategoryDragHandlers,
  attachDragHandlers,
} from "@components/channel-sidebar/dragReorder";
import type { ChannelReorderData } from "@components/ChannelSidebar";
import { authStore } from "@stores/auth.store";
import { channelsStore, setCategories, setRoles } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import { Permission } from "@lib/types";
import { resetAuthState, resetChannelsState } from "../helpers/storeSeeds";

const ROW = 20;

function ch(
  id: number,
  position: number,
  over: Partial<Channel> & { catId?: number; cat?: string; catPos?: number } = {},
): Channel {
  const { catId, cat, catPos, ...rest } = over;
  return {
    id,
    name: `ch-${id}`,
    type: "text",
    category: cat ?? null,
    ...(catId !== undefined ? { categoryId: catId } : {}),
    ...(catPos !== undefined ? { categoryPosition: catPos } : {}),
    position,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    topic: "",
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...rest,
  };
}

function signIn(role: string): void {
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "tester", avatar: null, role },
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
}

/** A group as the sidebar draws it. `key` null is the uncategorized text area (no header). */
interface Spec {
  readonly key: string | null;
  readonly categoryId: number;
  readonly name: string;
  /** Rows drawn; a collapsed category draws none, but the store still holds its channels. */
  readonly rows: readonly Channel[];
}

interface Sidebar {
  root: HTMLElement;
  groups: Map<string | null, HTMLElement>;
  headers: Map<string | null, HTMLElement>;
  rows: Map<number, HTMLElement>;
}

function stub(el: HTMLElement, top: number, height: number): void {
  el.getBoundingClientRect = () => {
    const live = el.isConnected;
    return {
      top: live ? top : 0,
      bottom: live ? top + height : 0,
      height: live ? height : 0,
      left: 0,
      right: live ? 100 : 0,
      width: live ? 100 : 0,
      x: 0,
      y: live ? top : 0,
      toJSON: () => ({}),
    };
  };
}

interface Handlers {
  readonly lifetime: AbortSignal;
  readonly onReorder: (reorders: readonly ChannelReorderData[]) => void;
  readonly onReorderCategory: (categoryId: number, targetId: number, before: boolean) => void;
}

/** Draw `specs` top to bottom, 20px per header and per row, and bind the drag handlers. */
function build(specs: readonly Spec[], h: Handlers, render: AbortSignal): Sidebar {
  const root = document.createElement("div");
  root.className = "channel-list";
  document.body.appendChild(root);
  const out: Sidebar = {
    root,
    groups: new Map(),
    headers: new Map(),
    rows: new Map(),
  };
  let y = 0;
  for (const spec of specs) {
    const group = document.createElement("div");
    root.appendChild(group);
    const groupTop = y;
    if (spec.key !== null) {
      const header = document.createElement("div");
      header.className = "category";
      header.dataset.category = spec.name;
      header.dataset.categoryKey = spec.key;
      if (spec.categoryId > 0) header.dataset.categoryId = String(spec.categoryId);
      stub(header, y, ROW);
      y += ROW;
      group.appendChild(header);
      out.headers.set(spec.key, header);
      if (spec.categoryId > 0) {
        attachCategoryDragHandlers(
          header,
          spec.categoryId,
          render,
          h.lifetime,
          h.onReorderCategory,
        );
      }
    }
    const container = document.createElement("div");
    container.className = "category-channels-container";
    group.appendChild(container);
    for (const channel of spec.rows) {
      const el = document.createElement("div");
      stub(el, y, ROW);
      y += ROW;
      container.appendChild(el);
      out.rows.set(channel.id, el);
      attachDragHandlers(el, channel, container, spec.rows, render, h.lifetime, h.onReorder);
    }
    stub(group, groupTop, y - groupTop);
    out.groups.set(spec.key, group);
  }
  return out;
}

function mouse(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, { clientX: 0, clientY, button: 0, buttons: 1, bubbles: true });
}

/** Press on `from`, move past the threshold, release at `y`. */
function dragTo(from: HTMLElement, fromY: number, y: number): void {
  from.dispatchEvent(mouse("mousedown", fromY));
  from.dispatchEvent(mouse("mousemove", fromY + 20));
  document.dispatchEvent(mouse("mouseup", y));
}

const lifetimes: AbortController[] = [];

function handlers(): Handlers & {
  onReorder: Mock<Handlers["onReorder"]>;
  onReorderCategory: Mock<Handlers["onReorderCategory"]>;
} {
  const ac = new AbortController();
  lifetimes.push(ac);
  return {
    lifetime: ac.signal,
    onReorder: vi.fn<Handlers["onReorder"]>(),
    onReorderCategory: vi.fn<Handlers["onReorderCategory"]>(),
  };
}

function seed(
  channels: readonly Channel[],
  categories = [] as { id: number; name: string; position: number }[],
): void {
  setCategories(categories);
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map(channels.map((c) => [c.id, c])),
  }));
}

function reordersOf(fn: Mock<Handlers["onReorder"]>): readonly ChannelReorderData[] {
  expect(fn).toHaveBeenCalledTimes(1);
  return fn.mock.calls[0]?.[0] as readonly ChannelReorderData[];
}

function summary(reorders: readonly ChannelReorderData[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of reorders) out[r.channelId] = r.newPosition;
  return out;
}

const stored = (id: number): Channel | undefined => channelsStore.getState().channels.get(id);

beforeEach(() => {
  resetAuthState();
  resetChannelsState();
  document.body.className = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  document.dispatchEvent(mouse("mouseup", -1000));
  for (const ac of lifetimes) ac.abort();
  lifetimes.length = 0;
  document.body.innerHTML = "";
  document.body.className = "";
});

// Category A (id 10) holds 1 and 2; category B (id 11) holds 3 and 4.
const A = [
  ch(1, 0, { catId: 10, cat: "A", catPos: 0 }),
  ch(2, 1, { catId: 10, cat: "A", catPos: 0 }),
];
const B = [
  ch(3, 5, { catId: 11, cat: "B", catPos: 1 }),
  ch(4, 6, { catId: 11, cat: "B", catPos: 1 }),
];
const CATEGORIES = [
  { id: 10, name: "A", position: 0 },
  { id: 11, name: "B", position: 1 },
];
const SPECS: readonly Spec[] = [
  { key: "cat:10", categoryId: 10, name: "A", rows: A },
  { key: "cat:11", categoryId: 11, name: "B", rows: B },
];

describe("dragging a channel into another category", () => {
  it("a drop on a row of another category files the channel there and re-slots the target group", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);

    // Rows: A header 0-20, ch1 20-40, ch2 40-60, B header 60-80, ch3 80-100, ch4 100-120.
    dragTo(sb.rows.get(1)!, 25, 104); // top half of ch4: B becomes [3, 1, 4]

    const reorders = reordersOf(h.onReorder);
    // B's slots 5, 6 gain a third at 7: ch3 keeps 5, ch1 takes 6, ch4 moves to 7.
    expect(summary(reorders)).toEqual({ 1: 6, 4: 7 });
    expect(reorders.find((r) => r.channelId === 1)?.category).toEqual({
      previous: { categoryId: 10, category: "A", categoryPosition: 0 },
      next: { categoryId: 11, category: "B", categoryPosition: 1 },
    });
    expect(reorders.find((r) => r.channelId === 4)?.category).toBeUndefined();
    expect(reorders.find((r) => r.channelId === 4)?.previousPosition).toBe(6);
    // The store is already optimistic, through the existing helpers.
    expect(stored(1)).toMatchObject({
      categoryId: 11,
      category: "B",
      categoryPosition: 1,
      position: 6,
    });
    expect(stored(4)?.position).toBe(7);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
  });

  it("the bottom half of the last row appends after it", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);

    dragTo(sb.rows.get(1)!, 25, 116); // bottom half of ch4

    expect(summary(reordersOf(h.onReorder))).toEqual({ 1: 7 });
  });

  it("a drop on the category header appends at the end of that category", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);

    dragTo(sb.rows.get(1)!, 25, 70); // B's header

    const reorders = reordersOf(h.onReorder);
    expect(summary(reorders)).toEqual({ 1: 7 });
    expect(reorders[0]?.category?.next).toEqual({
      categoryId: 11,
      category: "B",
      categoryPosition: 1,
    });
    expect(stored(1)).toMatchObject({ categoryId: 11, position: 7 });
  });

  it("a collapsed category accepts a drop on its header and appends after all its channels", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    // B is collapsed: its header is drawn, its rows are not.
    const sb = build(
      [SPECS[0] as Spec, { key: "cat:11", categoryId: 11, name: "B", rows: [] }],
      h,
      h.lifetime,
    );

    dragTo(sb.rows.get(1)!, 25, 70);

    expect(summary(reordersOf(h.onReorder))).toEqual({ 1: 7 });
  });

  it("a drop on the header of an empty category takes the next free position", () => {
    signIn("owner");
    seed([...A, ...B], [...CATEGORIES, { id: 12, name: "Empty", position: 2 }]);
    const h = handlers();
    const sb = build(
      [...SPECS, { key: "cat:12", categoryId: 12, name: "Empty", rows: [] }],
      h,
      h.lifetime,
    );

    dragTo(sb.rows.get(1)!, 25, 130); // Empty's header, 120-140

    const reorders = reordersOf(h.onReorder);
    expect(summary(reorders)).toEqual({ 1: 7 });
    expect(reorders[0]?.category?.next).toEqual({
      categoryId: 12,
      category: "Empty",
      categoryPosition: 2,
    });
  });

  it("a drop in the uncategorized area files the channel under no category", () => {
    signIn("owner");
    const loose = [ch(7, 3), ch(8, 4)];
    seed([...A, ...loose], CATEGORIES);
    const h = handlers();
    const sb = build(
      [{ key: null, categoryId: 0, name: "", rows: loose }, { ...(SPECS[0] as Spec) }],
      h,
      h.lifetime,
    );

    // Uncategorized rows: ch7 0-20, ch8 20-40; A header 40-60, ch1 60-80, ch2 80-100.
    dragTo(sb.rows.get(1)!, 65, 25); // top half of ch8

    const reorders = reordersOf(h.onReorder);
    expect(reorders.find((r) => r.channelId === 1)?.category?.next).toEqual({
      categoryId: 0,
      category: "",
      categoryPosition: 0,
    });
    expect(stored(1)).toMatchObject({ categoryId: 0, category: "" });
    expect(summary(reorders)).toEqual({ 1: 4, 8: 5 });
  });

  it("nudges tied positions in the target group, as a within-category drop does", () => {
    signIn("owner");
    const tied = [
      ch(3, 0, { catId: 11, cat: "B", catPos: 1 }),
      ch(4, 0, { catId: 11, cat: "B", catPos: 1 }),
    ];
    seed([...A, ...tied], CATEGORIES);
    const h = handlers();
    const sb = build(
      [SPECS[0] as Spec, { key: "cat:11", categoryId: 11, name: "B", rows: tied }],
      h,
      h.lifetime,
    );

    dragTo(sb.rows.get(1)!, 25, 84); // top half of ch3

    // Slots [0, 0] plus a third become 0, 1, 2 for [1, 3, 4]; the moved channel is always reported.
    expect(summary(reordersOf(h.onReorder))).toEqual({ 1: 0, 3: 1, 4: 2 });
  });
});

describe("text above voice across categories", () => {
  const voiceB = ch(5, 8, { type: "voice", catId: 11, cat: "B", catPos: 1 });
  const textB = [B[0] as Channel, B[1] as Channel];
  const withVoice: readonly Spec[] = [
    {
      key: "cat:10",
      categoryId: 10,
      name: "A",
      rows: [...A, ch(6, 2, { type: "voice", catId: 10, cat: "A", catPos: 0 })],
    },
    { key: "cat:11", categoryId: 11, name: "B", rows: [...textB, voiceB] },
  ];
  const all = [...A, ch(6, 2, { type: "voice", catId: 10, cat: "A", catPos: 0 }), ...textB, voiceB];

  it("a text channel dropped on a voice row lands after the last text row", () => {
    signIn("owner");
    seed(all, CATEGORIES);
    const h = handlers();
    const sb = build(withVoice, h, h.lifetime);

    // A: header 0, ch1 20, ch2 40, ch6 60; B: header 80, ch3 100, ch4 120, ch5 140.
    dragTo(sb.rows.get(1)!, 25, 144); // top half of the voice row

    // B displays [3, 4, 1, 5]: slots 5, 6, 8 + 9.
    expect(summary(reordersOf(h.onReorder))).toEqual({ 1: 8, 5: 9 });
  });

  it("a text channel dropped on the header lands before the voice rows", () => {
    signIn("owner");
    seed(all, CATEGORIES);
    const h = handlers();
    const sb = build(withVoice, h, h.lifetime);

    dragTo(sb.rows.get(1)!, 25, 90);

    expect(summary(reordersOf(h.onReorder))).toEqual({ 1: 8, 5: 9 });
  });

  it("a voice channel dropped on a text row lands among the voice rows, at their start", () => {
    signIn("owner");
    seed(all, CATEGORIES);
    const h = handlers();
    const sb = build(withVoice, h, h.lifetime);

    dragTo(sb.rows.get(6)!, 65, 104); // top half of ch3, a text row

    // B displays [3, 4, 6, 5]: voice 6 takes the voice section's start.
    expect(summary(reordersOf(h.onReorder))).toEqual({ 6: 8, 5: 9 });
    expect(stored(6)).toMatchObject({ categoryId: 11, type: "voice" });
  });

  it("a voice channel dropped on the header goes after the existing voice rows", () => {
    signIn("owner");
    seed(all, CATEGORIES);
    const h = handlers();
    const sb = build(withVoice, h, h.lifetime);

    dragTo(sb.rows.get(6)!, 65, 90);

    // B displays [3, 4, 5, 6]: 6 takes the new last slot.
    expect(summary(reordersOf(h.onReorder))).toEqual({ 6: 9 });
  });

  it("a text channel cannot be dropped on the synthetic Voice group", () => {
    signIn("owner");
    const lone = ch(9, 4, { type: "voice" });
    seed([...A, lone], CATEGORIES);
    const h = handlers();
    const sb = build(
      [
        { key: "Voice", categoryId: 0, name: "Voice", rows: [lone] },
        { key: "cat:10", categoryId: 10, name: "A", rows: A },
      ],
      h,
      h.lifetime,
    );

    // Voice: header 0, ch9 20; A: header 40, ch1 60, ch2 80.
    dragTo(sb.rows.get(1)!, 65, 10); // the Voice header
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(stored(1)).toMatchObject({ categoryId: 10, position: 0 });
  });

  it("a voice channel dropped on the Voice group's header goes uncategorized", () => {
    signIn("owner");
    const lone = ch(9, 4, { type: "voice" });
    const inA = ch(6, 2, { type: "voice", catId: 10, cat: "A", catPos: 0 });
    seed([...A, inA, lone], CATEGORIES);
    const h = handlers();
    const sb = build(
      [
        { key: "Voice", categoryId: 0, name: "Voice", rows: [lone] },
        { key: "cat:10", categoryId: 10, name: "A", rows: [...A, inA] },
      ],
      h,
      h.lifetime,
    );

    dragTo(sb.rows.get(6)!, 125, 10);

    const reorders = reordersOf(h.onReorder);
    expect(reorders[0]?.category?.next).toMatchObject({ categoryId: 0, category: "" });
    expect(summary(reorders)).toEqual({ 6: 5 });
  });
});

describe("a channel drag when the viewer loses MANAGE_CHANNELS mid-drag", () => {
  it("is dropped on release: no callback and no store write", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);

    sb.rows.get(1)!.dispatchEvent(mouse("mousedown", 25));
    sb.rows.get(1)!.dispatchEvent(mouse("mousemove", 45));
    signIn("member");
    document.dispatchEvent(mouse("mouseup", 104));

    expect(h.onReorder).not.toHaveBeenCalled();
    expect(stored(1)).toMatchObject({ categoryId: 10, position: 0 });
    expect(sb.rows.get(1)?.classList.contains("dragging")).toBe(false);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
  });
});

describe("a legacy name-only category", () => {
  it("is not a drop target for a move (it has no id to file under)", () => {
    signIn("owner");
    const legacy = [ch(3, 5, { cat: "Old" })];
    seed([...A, ...legacy], CATEGORIES);
    const h = handlers();
    const sb = build(
      [SPECS[0] as Spec, { key: "Old", categoryId: 0, name: "Old", rows: legacy }],
      h,
      h.lifetime,
    );

    dragTo(sb.rows.get(1)!, 25, 70);

    expect(h.onReorder).not.toHaveBeenCalled();
    expect(stored(1)).toMatchObject({ categoryId: 10, position: 0 });
  });
});

describe("a non-manager cannot drag", () => {
  it("draws no drag affordance and starts no drag", () => {
    signIn("member");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);

    expect(sb.rows.get(1)?.classList.contains("channel-draggable")).toBe(false);
    expect(sb.headers.get("cat:10")?.classList.contains("category-draggable")).toBe(false);

    dragTo(sb.rows.get(1)!, 25, 70);
    sb.headers.get("cat:10")!.dispatchEvent(mouse("mousedown", 5));
    sb.headers.get("cat:10")!.dispatchEvent(mouse("mousemove", 40));
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
    document.dispatchEvent(mouse("mouseup", 100));

    expect(h.onReorder).not.toHaveBeenCalled();
    expect(h.onReorderCategory).not.toHaveBeenCalled();
  });

  it("a custom role holding MANAGE_CHANNELS may", () => {
    setRoles([{ id: 9, name: "Curator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    signIn("Curator");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);

    expect(sb.headers.get("cat:10")?.classList.contains("category-draggable")).toBe(true);
    dragTo(sb.rows.get(1)!, 25, 70);
    expect(h.onReorder).toHaveBeenCalledTimes(1);
  });
});

describe("drop indicator across categories", () => {
  it("marks a header and a row of another category, and clears them on release", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const sb = build(SPECS, h, h.lifetime);
    const source = sb.rows.get(1)!;

    source.dispatchEvent(mouse("mousedown", 25));
    source.dispatchEvent(mouse("mousemove", 45));

    document.dispatchEvent(mouse("mousemove", 70));
    expect(sb.headers.get("cat:11")?.classList.contains("channel-drop-indicator")).toBe(true);

    document.dispatchEvent(mouse("mousemove", 104));
    expect(sb.headers.get("cat:11")?.classList.contains("channel-drop-indicator")).toBe(false);
    expect(sb.rows.get(4)?.classList.contains("channel-drop-indicator")).toBe(true);

    document.dispatchEvent(mouse("mouseup", 104));
    expect(document.querySelectorAll(".channel-drop-indicator")).toHaveLength(0);
  });
});

describe("a re-render mid-drag with the drop target in another container (edge case 1)", () => {
  it("resolves the drop against the live rows of the other category", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const first = new AbortController();
    const old = build(SPECS, h, first.signal);

    old.rows.get(1)!.dispatchEvent(mouse("mousedown", 25));
    old.rows.get(1)!.dispatchEvent(mouse("mousemove", 45));
    expect(old.rows.get(1)?.classList.contains("dragging")).toBe(true);

    // renderChannels() rebuilds every group; the captured container is detached,
    // and the target row (ch4, in B's container) is a different element now.
    first.abort();
    old.root.remove();
    const live = build(SPECS, h, new AbortController().signal);
    expect(live.rows.get(4)).not.toBe(old.rows.get(4));

    document.dispatchEvent(mouse("mousemove", 104));
    expect(live.rows.get(4)?.classList.contains("channel-drop-indicator")).toBe(true);
    expect(live.rows.get(1)?.classList.contains("dragging")).toBe(true);

    document.dispatchEvent(mouse("mouseup", 104));

    expect(summary(reordersOf(h.onReorder))).toEqual({ 1: 6, 4: 7 });
    expect(stored(1)).toMatchObject({ categoryId: 11, position: 6 });
    expect(document.querySelectorAll(".channel-drop-indicator")).toHaveLength(0);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
  });

  it("drops a move whose dragged channel has no live row after the re-render", () => {
    signIn("owner");
    seed([...A, ...B], CATEGORIES);
    const h = handlers();
    const first = new AbortController();
    const old = build(SPECS, h, first.signal);

    old.rows.get(1)!.dispatchEvent(mouse("mousedown", 25));
    old.rows.get(1)!.dispatchEvent(mouse("mousemove", 45));
    first.abort();
    old.root.remove();
    build(
      [{ key: "cat:10", categoryId: 10, name: "A", rows: [A[1] as Channel] }, SPECS[1] as Spec],
      h,
      new AbortController().signal,
    );

    document.dispatchEvent(mouse("mouseup", 84));

    expect(h.onReorder).not.toHaveBeenCalled();
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
  });
});

describe("dragging a category header", () => {
  const three: readonly Spec[] = [
    { key: "cat:10", categoryId: 10, name: "A", rows: A },
    { key: "cat:11", categoryId: 11, name: "B", rows: B },
    { key: "cat:12", categoryId: 12, name: "C", rows: [] },
  ];
  const cats = [...CATEGORIES, { id: 12, name: "C", position: 2 }];

  it("only a real category header is draggable", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const sb = build(
      [
        { key: null, categoryId: 0, name: "", rows: [] },
        { key: "Voice", categoryId: 0, name: "Voice", rows: [] },
        { key: "Old", categoryId: 0, name: "Old", rows: [] },
        ...three,
      ],
      h,
      h.lifetime,
    );

    expect(sb.headers.get("Voice")?.classList.contains("category-draggable")).toBe(false);
    expect(sb.headers.get("Old")?.classList.contains("category-draggable")).toBe(false);
    expect(sb.headers.get("cat:10")?.classList.contains("category-draggable")).toBe(true);
  });

  it("dropping on the lower part of another category's group sends it after that category", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const sb = build(three, h, h.lifetime);
    const header = sb.headers.get("cat:10")!;

    // A: 0-60; B: header 60-80, rows to 120; C: header 120-140.
    header.dispatchEvent(mouse("mousedown", 5));
    header.dispatchEvent(mouse("mousemove", 30));
    expect(header.classList.contains("dragging")).toBe(true);
    document.dispatchEvent(mouse("mousemove", 100));
    expect(sb.groups.get("cat:11")?.classList.contains("category-drop-after")).toBe(true);
    document.dispatchEvent(mouse("mouseup", 100));

    expect(h.onReorderCategory).toHaveBeenCalledExactlyOnceWith(10, 11, false);
    expect(h.onReorder).not.toHaveBeenCalled();
    expect(header.classList.contains("dragging")).toBe(false);
    expect(document.querySelectorAll(".category-drop-after, .category-drop-before")).toHaveLength(
      0,
    );
    // Nothing is applied here: the channel_categories frame does that.
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([10, 11, 12]);
  });

  it("dropping on the upper half of another header sends it before that category", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const sb = build(three, h, h.lifetime);
    const header = sb.headers.get("cat:12")!;

    header.dispatchEvent(mouse("mousedown", 125));
    header.dispatchEvent(mouse("mousemove", 100));
    document.dispatchEvent(mouse("mouseup", 65)); // B's header, upper half

    expect(h.onReorderCategory).toHaveBeenCalledExactlyOnceWith(12, 11, true);
  });

  it("a drop on itself, on the uncategorized area or off every category sends nothing", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const sb = build(three, h, h.lifetime);
    const header = sb.headers.get("cat:11")!;

    dragTo(header, 65, 70); // its own header
    dragTo(header, 65, 9999); // below everything
    expect(h.onReorderCategory).not.toHaveBeenCalled();
  });

  it("a press on the header's button stays a click, not a drag", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const sb = build(three, h, h.lifetime);
    const header = sb.headers.get("cat:10")!;
    const arrow = document.createElement("button");
    header.appendChild(arrow);

    arrow.dispatchEvent(mouse("mousedown", 5));
    header.dispatchEvent(mouse("mousemove", 40));

    expect(header.classList.contains("dragging")).toBe(false);
  });

  it("is refused when the viewer lost MANAGE_CHANNELS mid-drag", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const sb = build(three, h, h.lifetime);
    const header = sb.headers.get("cat:10")!;

    header.dispatchEvent(mouse("mousedown", 5));
    header.dispatchEvent(mouse("mousemove", 30));
    signIn("member");
    document.dispatchEvent(mouse("mouseup", 100));

    expect(h.onReorderCategory).not.toHaveBeenCalled();
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
    expect(header.classList.contains("dragging")).toBe(false);
  });

  it("survives a re-render mid-drag and swallows the click that ends the press", () => {
    signIn("owner");
    seed([...A, ...B], cats);
    const h = handlers();
    const first = new AbortController();
    const old = build(three, h, first.signal);
    const header = old.headers.get("cat:10")!;

    header.dispatchEvent(mouse("mousedown", 5));
    header.dispatchEvent(mouse("mousemove", 30));
    first.abort();
    old.root.remove();
    const render = new AbortController();
    const live = build(three, h, render.signal);
    const toggle = vi.fn();
    live.headers.get("cat:10")!.addEventListener("click", toggle);

    document.dispatchEvent(mouse("mousemove", 100));
    expect(live.headers.get("cat:10")?.classList.contains("dragging")).toBe(true);
    document.dispatchEvent(mouse("mouseup", 100));
    expect(h.onReorderCategory).toHaveBeenCalledExactlyOnceWith(10, 11, false);

    live.headers.get("cat:10")!.click();
    expect(toggle).not.toHaveBeenCalled();
  });
});
