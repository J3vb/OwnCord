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
vi.mock("@lib/media-visibility", () => ({
  observeMedia: observeMediaMock,
  discardMedia: discardMediaMock,
}));

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";

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
  return {
    channelId: 1,
    user: { id: 1, username: "Alice", avatar: null },
    content: `Message ${overrides.id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
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
});
