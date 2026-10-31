import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { createMessageList } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "../helpers/messageFactory";

function makeMessage(id: number): Message {
  return buildMessage(
    { id },
    {
      user: { id: id, username: `user${id}`, avatar: null },
      timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0, id)).toISOString(),
    },
  );
}

describe("MessageList scroll frame layout reads", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let root: HTMLElement;
  let rafs: FrameRequestCallback[];
  const reads = { scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
  let scrollTop = 0;

  beforeEach(() => {
    messagesStore.setState(() => ({
      messagesByChannel: new Map([[1, Array.from({ length: 300 }, (_, i) => makeMessage(i + 1))]]),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
    rafs = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => rafs.push(cb));
    container = document.createElement("div");
    document.body.appendChild(container);
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
    });
    msgList.mount(container);
    root = container.querySelector<HTMLElement>(".messages-container")!;
    scrollTop = 5000;
    Object.defineProperty(root, "scrollTop", {
      configurable: true,
      get: () => {
        reads.scrollTop++;
        return scrollTop;
      },
      set: (v: number) => {
        scrollTop = v;
      },
    });
    Object.defineProperty(root, "clientHeight", {
      configurable: true,
      get: () => {
        reads.clientHeight++;
        return 600;
      },
    });
    Object.defineProperty(root, "scrollHeight", {
      configurable: true,
      get: () => {
        reads.scrollHeight++;
        return 20000;
      },
    });
    rafs.length = 0;
  });

  afterEach(() => {
    msgList.destroy?.();
    container.remove();
    vi.restoreAllMocks();
  });

  function resetReads(): void {
    reads.scrollTop = reads.clientHeight = reads.scrollHeight = 0;
  }

  function totalReads(): number {
    return reads.scrollTop + reads.clientHeight + reads.scrollHeight;
  }

  it("reads each layout property once for a whole scroll frame, rAF included", () => {
    resetReads();
    root.dispatchEvent(new Event("scroll"));
    for (const cb of rafs.splice(0)) cb(0);
    expect(reads.scrollTop).toBe(1);
    expect(reads.clientHeight).toBe(1);
    expect(reads.scrollHeight).toBe(1);
  });

  it("keeps one read per frame while the window slides", () => {
    resetReads();
    for (let frame = 0; frame < 10; frame++) {
      scrollTop = 5000 - frame * 900;
      root.dispatchEvent(new Event("scroll"));
      for (const cb of rafs.splice(0)) cb(0);
    }
    expect(totalReads()).toBeLessThanOrEqual(10 * 3);
  });

  it("writes the jump button once for a burst of scroll events", () => {
    const btn = container.querySelector<HTMLButtonElement>(".scroll-to-bottom-btn")!;
    const setAttr = vi.spyOn(btn, "setAttribute");
    for (let i = 0; i < 10; i++) {
      scrollTop = 5000 - i;
      root.dispatchEvent(new Event("scroll"));
    }
    expect(setAttr.mock.calls.filter(([name]) => name === "aria-label")).toHaveLength(1);
    expect(btn.classList.contains("visible")).toBe(true);
  });

  it("renders for the live scrollTop when a write lands between the scroll event and its rAF", () => {
    root.dispatchEvent(new Event("scroll"));
    // PageUp from the message box moves the viewport before the frame runs.
    msgList.scrollPage(-1);
    expect(scrollTop).toBeLessThan(5000);
    resetReads();
    for (const cb of rafs.splice(0)) cb(0);
    // The frame must read the moved position, not reuse the one from the event.
    expect(reads.scrollTop).toBeGreaterThanOrEqual(1);
  });
});
