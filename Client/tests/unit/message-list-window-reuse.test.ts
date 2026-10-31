import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom does not provide ResizeObserver — stub it so MessageList can mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  } as unknown as typeof ResizeObserver;
}

const { fetchImageAsObjectUrlMock } = vi.hoisted(() => ({
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

const { observeMediaMock, discardMediaMock } = vi.hoisted(() => ({
  observeMediaMock: vi.fn(),
  discardMediaMock: vi.fn(),
}));
vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));
vi.mock("@lib/prefs/mediaVisibility", () => ({
  observeMedia: observeMediaMock,
  discardMedia: discardMediaMock,
}));

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "../helpers/messageFactory";

const ROW_H = 61;

function resetStores(): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return buildMessage(overrides);
}

function setMessages(channelId: number, messages: Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(channelId, messages);
    return { ...prev, messagesByChannel: next };
  });
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

describe("MessageList incremental window shift", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let options: MessageListOptions;
  let root: HTMLDivElement;
  let content: HTMLElement;
  let topSpacer: HTMLElement;

  async function scrollTo(top: number): Promise<void> {
    root.scrollTop = top;
    root.dispatchEvent(new Event("scroll"));
    await nextFrame();
  }

  beforeEach(async () => {
    resetStores();
    observeMediaMock.mockClear();
    discardMediaMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = {
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    // Distinct authors so no row is grouped; each one estimates ROW_H.
    setMessages(
      1,
      Array.from({ length: 300 }, (_, i) =>
        makeMessage({
          id: i + 1,
          user: { id: i + 1, username: `user${i + 1}`, avatar: null },
          content: `Message ${i + 1}`,
        }),
      ),
    );
    msgList = createMessageList(options);
    msgList.mount(container);
    root = container.querySelector(".messages-container") as HTMLDivElement;
    content = container.querySelector(".virtual-content") as HTMLElement;
    topSpacer = container.querySelector(".virtual-spacer-top") as HTMLElement;
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });
    // Let mount's trailing scroll-to-bottom frame settle before measuring.
    await nextFrame();
    await nextFrame();
  });

  afterEach(() => {
    msgList.destroy?.();
    container.remove();
  });

  it("keeps the DOM nodes of rows still in range when the viewport moves one row", async () => {
    await scrollTo(ROW_H * 150);
    const before = [...content.children];
    const beforeTop = parseFloat(topSpacer.style.height);
    expect(before.length).toBeGreaterThan(30);
    discardMediaMock.mockClear();

    await scrollTo(ROW_H * 151);
    const after = [...content.children];

    const beforeSet = new Set(before);
    const kept = after.filter((el) => beforeSet.has(el));
    const created = after.filter((el) => !beforeSet.has(el));
    expect(created.length).toBeLessThanOrEqual(3);
    expect(kept.length).toBeGreaterThanOrEqual(before.length - 3);
    // Kept rows stay in their original relative order.
    expect(kept).toEqual(before.filter((el) => after.includes(el)));

    // The window slid down: the top spacer grew by about one row, and the row
    // count is within a row or two of what it was.
    const afterTop = parseFloat(topSpacer.style.height);
    expect(afterTop).toBeGreaterThan(beforeTop);
    expect(afterTop - beforeTop).toBeLessThanOrEqual(ROW_H * 3);
    expect(Math.abs(after.length - before.length)).toBeLessThanOrEqual(2);
  });

  it("releases only the rows that left the window, not the kept ones", async () => {
    await scrollTo(ROW_H * 150);
    const before = [...content.children];
    // Give every rendered row a tracked image, as a media message would have.
    for (const row of before) row.appendChild(document.createElement("img"));
    discardMediaMock.mockClear();

    await scrollTo(ROW_H * 151);
    const after = new Set(content.children);
    const leftImgs = before
      .filter((el) => !after.has(el))
      .flatMap((el) => [...el.querySelectorAll("img")]);
    const stayedImgs = before
      .filter((el) => after.has(el))
      .flatMap((el) => [...el.querySelectorAll("img")]);

    expect(stayedImgs.length).toBeGreaterThan(0);
    expect(leftImgs.length).toBeGreaterThan(0);
    // Compare by identity: toHaveBeenCalledWith would match any empty <img>.
    const released = discardMediaMock.mock.calls.map((call) => call[0]);
    for (const img of stayedImgs) expect(released).not.toContain(img);
    for (const img of leftImgs) expect(released).toContain(img);
  });

  it("still replaces every row on a disjoint jump", async () => {
    await scrollTo(ROW_H * 150);
    const before = [...content.children];
    expect(before.length).toBeGreaterThan(30);

    await scrollTo(0);
    const after = [...content.children];

    expect(after.length).toBeGreaterThan(0);
    const beforeSet = new Set(before);
    expect(after.some((el) => beforeSet.has(el))).toBe(false);
  });

  /** Count `offsetHeight` reads while `run` executes. */
  async function countHeightReads(run: () => Promise<void>): Promise<number> {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    let reads = 0;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        reads++;
        return ROW_H;
      },
    });
    try {
      await run();
    } finally {
      if (desc === undefined)
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
      else Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
    }
    return reads;
  }

  it("measures only the rows that entered or left when the window slides", async () => {
    await scrollTo(ROW_H * 150);
    const before = new Set(content.children);
    // Synchronous slide: no ResizeObserver frame in the counted section.
    const reads = await countHeightReads(async () => {
      root.scrollTop = ROW_H * 151;
      root.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    // The scroll handler runs on a frame; wait for it, counting its reads.
    const readsAfterFrame = await countHeightReads(async () => {
      await nextFrame();
    });
    const after = new Set(content.children);
    const entered = [...after].filter((el) => !before.has(el)).length;
    const departed = [...before].filter((el) => !after.has(el)).length;
    expect(entered).toBeGreaterThan(0);
    expect(reads + readsAfterFrame).toBeLessThanOrEqual(entered + departed + 2);
  });

  it("measures every rendered row on a full rebuild", async () => {
    await scrollTo(ROW_H * 150);
    const reads = await countHeightReads(async () => {
      await scrollTo(0);
    });
    expect(reads).toBeGreaterThanOrEqual(content.children.length);
  });

  it("records a grown row's height when the window slides it out before the resize frame", async () => {
    await scrollTo(ROW_H * 150);
    const before = [...content.children];
    const grown = before[0] as HTMLElement;
    const topBefore = parseFloat(topSpacer.style.height);
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this === grown ? ROW_H + 200 : ROW_H;
      },
    });
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ marginTop: "0px", marginBottom: "0px" } as CSSStyleDeclaration);
    try {
      await scrollTo(ROW_H * 153);
    } finally {
      styleSpy.mockRestore();
      if (desc === undefined)
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
      else Object.defineProperty(HTMLElement.prototype, "offsetHeight", desc);
    }
    const after = new Set(content.children);
    expect(after.has(grown)).toBe(false);
    const departed = before.filter((el) => !after.has(el)).length;
    // The rows above the window now sum to their old share, the departed rows'
    // estimates and the 200px the grown row gained while it was still drawn.
    expect(parseFloat(topSpacer.style.height) - topBefore).toBeCloseTo(departed * ROW_H + 200, 0);
  });
});
