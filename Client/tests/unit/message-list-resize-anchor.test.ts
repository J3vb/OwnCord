/**
 * A row that changes height after it is drawn (an image box settling, a link
 * card loading) must not move what the reader is looking at: rows above the
 * view are compensated in the same frame, growth inside the row straddling the
 * top edge leaves the rows below it in place, and a reader at the bottom stays
 * at the bottom however much the last row grew.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { observers } = vi.hoisted(() => ({ observers: [] as Array<() => void> }));

import { createMessageList } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { clearRowHeights } from "@components/message-list/rowHeights";

const CHANNEL_ID = 1;
const ROW = 100;

function makeMessage(id: number): Message {
  return {
    id,
    channelId: CHANNEL_ID,
    user: { id: 1000 + id, username: `User${id}`, avatar: "" },
    content: `Message ${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    // One minute apart: one day, no day dividers between the rows.
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id)).toISOString(),
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

describe("MessageList: rows resizing after they are drawn", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  /** Height of a row by its test id, when it is not ROW. */
  const grown = new Map<string, number>();
  const scrollTops = new WeakMap<Element, number>();
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  /** The scroller's height; 0 while it is hidden (display: none). */
  let view = 600;
  let width = 900;

  const rootEl = (): HTMLDivElement => container.querySelector(".messages-container")!;
  /** Two animation frames and the tasks after them, however loaded the run is. */
  const frame = async (): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    }
  };
  const rowHeight = (el: Element): number =>
    el instanceof HTMLElement && el.classList.contains("message")
      ? (grown.get(el.dataset["testid"] ?? "") ?? ROW)
      : 32;
  const spacer = (cls: string): number =>
    parseFloat(container.querySelector<HTMLElement>(`.${cls}`)?.style.height ?? "0") || 0;
  /** Layout the way the browser does it: spacers plus the drawn rows. */
  const contentHeight = (): number => {
    let h = spacer("virtual-spacer-top") + spacer("virtual-spacer-bottom");
    for (const el of container.querySelector(".virtual-content")!.children) h += rowHeight(el);
    return h;
  };
  /** A drawn row's top edge relative to the viewport. */
  const edge = (testId: string): number => {
    let top = spacer("virtual-spacer-top");
    for (const el of container.querySelector(".virtual-content")!.children) {
      if ((el as HTMLElement).dataset["testid"] === testId) return top - rootEl().scrollTop;
      top += rowHeight(el);
    }
    throw new Error(
      `${testId} is not drawn: st=${rootEl().scrollTop} top=${spacer("virtual-spacer-top")} ${[...container.querySelector(".virtual-content")!.children].map((e) => (e as HTMLElement).dataset["testid"] ?? e.className).join(",")}`,
    );
  };
  const gap = (): number => contentHeight() - rootEl().scrollTop - view;
  const scrollTo = async (top: number): Promise<void> => {
    rootEl().scrollTop = top;
    rootEl().dispatchEvent(new Event("scroll"));
    await frame();
  };
  const resize = (): void => {
    for (const cb of observers) cb();
  };

  beforeEach(() => {
    observers.length = 0;
    grown.clear();
    clearRowHeights();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    for (const name of [
      "scrollHeight",
      "offsetHeight",
      "clientWidth",
      "clientHeight",
      "scrollTop",
    ]) {
      saved[name] =
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ??
        Object.getOwnPropertyDescriptor(Element.prototype, name);
    }
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return rowHeight(this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        // Hidden, the scroller has no layout and nothing to scroll.
        return this.classList.contains("messages-container") && view > 0 ? contentHeight() : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => view,
    });
    // The browser clamps scrollTop to the scrollable range.
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement): number {
        return scrollTops.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        const max = Math.max(0, this.scrollHeight - view);
        scrollTops.set(this, Math.min(Math.max(0, v), max));
      },
    });
    messagesStore.setState(() => ({
      messagesByChannel: new Map([
        [CHANNEL_ID, Array.from({ length: 200 }, (_, i) => makeMessage(i + 1))],
      ]),
      pendingSends: new Map(),
      loadedChannels: new Set([CHANNEL_ID]),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
    setChannels([]);
    setActiveChannel(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    list = makeList();
  });

  const makeList = (): ReturnType<typeof createMessageList> =>
    createMessageList({
      channelId: CHANNEL_ID,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onEditEnd: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    view = 600;
    width = 900;
    container.remove();
    vi.unstubAllGlobals();
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(HTMLElement.prototype, name, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  /** The drawn message rows with their top edges, in order. */
  const drawn = (): Array<{ id: string; top: number; h: number }> => {
    let top = spacer("virtual-spacer-top") - rootEl().scrollTop;
    const out: Array<{ id: string; top: number; h: number }> = [];
    for (const el of container.querySelector(".virtual-content")!.children) {
      const h = rowHeight(el);
      const id = (el as HTMLElement).dataset["testid"];
      if (id?.startsWith("message-") === true) out.push({ id, top, h });
      top += h;
    }
    return out;
  };

  it("compensates a row growing above the view inside the observer callback", async () => {
    list!.mount(container);
    await frame();
    await scrollTo(10_000);
    const rows = drawn();
    const above = rows.findLast((r) => r.top + r.h <= 0)!;
    const shown = rows.find((r) => r.top >= 0)!;
    const before = edge(shown.id);
    grown.set(above.id, ROW + 40);
    resize();
    // No frame awaited: a correction deferred to the next frame paints one
    // frame with every row on screen pushed down.
    expect(edge(shown.id)).toBeCloseTo(before, 0);
  });

  it("keeps the rows below in place when the row straddling the top edge grows", async () => {
    list!.mount(container);
    await frame();
    await scrollTo(10_000);
    const first = drawn().find((r) => r.top >= 0)!;
    // Scroll so the row before it is cut in half by the top edge.
    await scrollTo(rootEl().scrollTop + first.top - ROW / 2);
    const rows = drawn();
    const straddling = rows.find((r) => r.top < 0 && r.top + r.h > 0)!;
    const next = rows[rows.indexOf(straddling) + 1]!;
    const before = edge(next.id);
    grown.set(straddling.id, ROW + 40);
    resize();
    // Whenever the pass runs, the rows below the grown one stay put.
    await frame();
    expect(edge(next.id)).toBeCloseTo(before, 0);
  });

  it("stays at the bottom when the last row grows past the bottom threshold", async () => {
    list!.mount(container);
    await frame();
    await scrollTo(contentHeight());
    expect(gap()).toBeCloseTo(0, 0);
    grown.set("message-200", ROW + 300);
    resize();
    await frame();
    expect(gap()).toBeCloseTo(0, 0);
  });

  it("opens at the bottom when it was mounted while hidden", async () => {
    // Switching channels while the call grid has the chat column.
    view = 0;
    list!.mount(container);
    await frame();
    view = 600;
    resize();
    await frame();
    expect(rootEl().scrollTop).toBeGreaterThan(0);
    expect(gap()).toBeCloseTo(0, 0);
  });

  it("keeps the reading position when it is hidden and shown again", async () => {
    list!.mount(container);
    await frame();
    await scrollTo(10_000);
    const shown = drawn().find((r) => r.top >= 0)!;
    const before = edge(shown.id);
    view = 0;
    resize();
    view = 600;
    resize();
    expect(edge(shown.id)).toBeCloseTo(before, 0);
  });

  it("ends at the bottom when a channel shorter than the view grows past it", async () => {
    // A short channel's rows land before their images: the content fits, so
    // scrolling to the bottom leaves scrollTop at 0, where the browser's own
    // scroll anchoring does nothing once the images make it taller.
    messagesStore.setState((s) => ({
      ...s,
      messagesByChannel: new Map([
        [CHANNEL_ID, Array.from({ length: 5 }, (_, i) => makeMessage(i + 1))],
      ]),
    }));
    list!.mount(container);
    await frame();
    expect(rootEl().scrollTop).toBe(0);
    for (let i = 1; i <= 5; i++) grown.set(`message-${i}`, 600);
    resize();
    await frame();
    expect(rootEl().scrollTop).toBeGreaterThan(0);
    expect(gap()).toBeCloseTo(0, 0);
  });

  /** Open the channel, read the oldest rows (drawn taller than estimated, like
   *  loaded link cards), and leave it: the height the next visit seeds from. */
  const visitTop = async (): Promise<number> => {
    for (let i = 1; i <= 8; i++) grown.set(`message-${i}`, 240);
    list!.mount(container);
    await frame();
    await scrollTo(0);
    await frame();
    await scrollTo(contentHeight());
    const total = contentHeight();
    list!.destroy?.();
    list = makeList();
    return total;
  };

  it("seeds a channel opened again with the row heights its last visit measured", async () => {
    const total = await visitTop();
    list!.mount(container);
    await frame();
    // Without them the oldest rows are estimated as plain text again, and the
    // spacer corrects itself under the reader while they scroll up.
    expect(contentHeight()).toBe(total);
  });

  it("does not seed from heights measured at another width", async () => {
    const total = await visitTop();
    width = 500;
    list!.mount(container);
    await frame();
    expect(contentHeight()).toBeLessThan(total);
  });

  it("seeds across a scrollbar's width", async () => {
    const total = await visitTop();
    // The empty list has no scrollbar yet; the filled one measured 8 px less.
    width = 908;
    list!.mount(container);
    await frame();
    expect(contentHeight()).toBe(total);
  });

  it("seeds a channel opened again while hidden once it is shown", async () => {
    const total = await visitTop();
    view = 0;
    width = 0;
    list!.mount(container);
    await frame();
    view = 600;
    width = 900;
    resize();
    await frame();
    expect(contentHeight()).toBe(total);
  });
});
