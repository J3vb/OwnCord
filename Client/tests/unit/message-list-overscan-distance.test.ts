import { describe, it, expect, vi, afterEach } from "vitest";

// jsdom does not provide ResizeObserver — stub it so MessageList can mount.
// jsdom does not provide ResizeObserver: a stub that lets a test fire the callbacks.
const observers = new Set<() => void>();
globalThis.ResizeObserver = class {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observers.add(this.cb);
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    observers.delete(this.cb);
  }
} as unknown as typeof ResizeObserver;

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

const nextFrame2 = nextFrame;

type Variant = "text" | "tall" | "grouped";

function build(variant: Variant): Message[] {
  return Array.from({ length: 400 }, (_, i) =>
    makeMessage({
      id: i + 1,
      // Distinct authors keep rows ungrouped; one author groups them (22 px).
      user:
        variant === "grouped"
          ? { id: 1, username: "Alice", avatar: null }
          : { id: i + 1, username: `user${i + 1}`, avatar: null },
      content: variant === "tall" ? `https://img.example.com/${i + 1}.png` : `Message ${i + 1}`,
      // Grouping needs timestamps within minutes of each other.
      timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0, i)).toISOString(),
    }),
  );
}

describe("MessageList overscan by distance", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let root: HTMLDivElement;
  let content: HTMLElement;

  async function mount(variant: Variant, clientHeight: number): Promise<void> {
    // The tall rows' images have no broker here; their load failure is noise.
    if (variant === "tall") vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    setMessages(1, build(variant));
    msgList = createMessageList({
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
    } satisfies MessageListOptions);
    root = null as unknown as HTMLDivElement;
    // clientHeight must be set before the first window is computed.
    const proto = HTMLElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientHeight", { configurable: true, value: clientHeight });
    try {
      msgList.mount(container);
      await nextFrame2();
      await nextFrame2();
    } finally {
      if (desc !== undefined) Object.defineProperty(proto, "clientHeight", desc);
      else delete (proto as unknown as Record<string, unknown>).clientHeight;
    }
    root = container.querySelector(".messages-container") as HTMLDivElement;
    content = container.querySelector(".virtual-content") as HTMLElement;
    Object.defineProperty(root, "clientHeight", { configurable: true, value: clientHeight });
  }

  async function scrollTo(top: number): Promise<void> {
    root.scrollTop = top;
    root.dispatchEvent(new Event("scroll"));
    await nextFrame2();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    msgList.destroy?.();
    container.remove();
  });

  it("short rows: a viewport of buffer each side, capped at 20 rows", async () => {
    await mount("text", 600);
    await scrollTo(ROW_H * 150);
    // ~10 visible rows (600 / 61) plus about one viewport (~10 rows) each way.
    const rows = content.children.length;
    expect(rows).toBeGreaterThanOrEqual(28);
    expect(rows).toBeLessThanOrEqual(34);
  });

  it("grouped one-line rows hit the 20-row ceiling, not a whole viewport", async () => {
    await mount("grouped", 600);
    await scrollTo(22 * 150);
    // ~28 visible rows; a 600 px margin would be 28 rows each way, capped at 20.
    const rows = content.children.length;
    expect(rows).toBeLessThanOrEqual(28 + 2 * 20 + 3);
    expect(rows).toBeGreaterThanOrEqual(28 + 2 * 20 - 6);
  });

  it("tall rows: far fewer rows than the old 20 each side, never below the 4-row floor", async () => {
    await mount("tall", 600);
    await scrollTo(400 * 150);
    const rows = content.children.length;
    // 600 px of ~280 px rows is 2-3 visible rows; the floor adds 4 each side.
    expect(rows).toBeLessThanOrEqual(3 + 2 * 6 + 2);
    expect(rows).toBeGreaterThanOrEqual(3 + 2 * 4);
    expect(rows).toBeLessThan(2 * 20);
  });

  it("a viewport that grows re-windows to cover it, with no scroll event", async () => {
    await mount("text", 300);
    await scrollTo(ROW_H * 150);
    const small = content.children.length;
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 1500 });
    for (const cb of observers) cb();
    await nextFrame2();
    await nextFrame2();
    // ~25 visible rows plus up to 20 each side, against ~13 before.
    expect(content.children.length).toBeGreaterThan(small + 15);
    const lastRow = content.lastElementChild as HTMLElement;
    const lastId = Number(lastRow.dataset.testid?.replace("message-", ""));
    expect(lastId).toBeGreaterThanOrEqual(150 + Math.ceil(1500 / ROW_H));
  });

  it("a viewport with no height keeps the 20-row buffer so the first render is not thin", async () => {
    await mount("text", 0);
    await scrollTo(ROW_H * 150);
    expect(content.children.length).toBeGreaterThanOrEqual(2 * 20);
  });

  it("scrollToMessage to a row far outside the window renders it on the first pass", async () => {
    await mount("tall", 600);
    await scrollTo(0);
    expect(msgList.scrollToMessage(300)).toBe(true);
    expect(container.querySelector("[data-testid='message-300']")).not.toBeNull();
  });
});
