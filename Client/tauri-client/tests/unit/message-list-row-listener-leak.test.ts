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

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { Message } from "@stores/messages.store";

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

// OC-0286: renderVirtualItem hands every row's listeners to the
// component-lifetime `ac.signal`, which only aborts in destroy(). A full
// renderWindow rebuild discards the old rows' DOM but never aborts their
// listeners, so each rebuild permanently retains a full window's worth of
// detached rows (and everything they reference) via the signal's abort-
// listener list. This is only observable indirectly in a unit test: a
// discarded row's button listener must stop firing once the render that
// owned it has been replaced, exactly as it already does for ChannelSidebar
// (renderAc, OC-0229) and SettingsOverlay (renderAC).
describe("MessageList row listener lifecycle (OC-0286)", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList>;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
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
    msgList = createMessageList(options);
  });

  afterEach(() => {
    msgList.destroy?.();
    container.remove();
  });

  it("aborts a discarded row's listeners on a full rebuild instead of retaining them for the component's lifetime", () => {
    setMessages(1, [makeMessage({ id: 2, content: "hello" })]);
    msgList.mount(container);

    const reactBtn = container.querySelector(
      '[data-testid="msg-react-2"]',
    ) as HTMLButtonElement | null;
    expect(reactBtn).not.toBeNull();

    // Sanity: the row is live, so its listener does fire.
    reactBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(options.onReactionClick).toHaveBeenCalledTimes(1);
    (options.onReactionClick as ReturnType<typeof vi.fn>).mockClear();

    // Prepend an older message — NOT a suffix extension, so the list takes
    // the full-rebuild path (renderWindow REBUILD) that discards the
    // currently rendered rows and replaces them with freshly rendered ones.
    setMessages(1, [
      makeMessage({ id: 1, content: "older", timestamp: "2024-01-15T11:00:00Z" }),
      makeMessage({ id: 2, content: "hello" }),
    ]);
    messagesStore.flush();

    // The button element is now detached from the document, but nothing
    // detaches its listener from the underlying signal until destroy() —
    // dispatching a click on the stale, discarded row must not still reach
    // the handler it closed over.
    reactBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(options.onReactionClick).not.toHaveBeenCalled();
  });

  it("does not abort a still-rendered row's listeners across an incremental append", () => {
    const first = makeMessage({ id: 1, content: "hello" });
    setMessages(1, [first]);
    msgList.mount(container);

    const reactBtn = container.querySelector(
      '[data-testid="msg-react-1"]',
    ) as HTMLButtonElement | null;
    expect(reactBtn).not.toBeNull();

    // Suffix extension (tail append fast path) — the existing row is kept in
    // the DOM as-is, so its listener must still be live.
    setMessages(1, [
      first,
      makeMessage({ id: 2, content: "follow-up", timestamp: "2024-01-15T12:01:00Z" }),
    ]);
    messagesStore.flush();

    expect(container.contains(reactBtn!)).toBe(true);
    reactBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(options.onReactionClick).toHaveBeenCalledTimes(1);
  });
});
