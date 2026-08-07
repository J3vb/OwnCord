/**
 * Message navigation: the jump orchestrator, the affordances that feed it, and
 * the "Jump to Present" pill that says the bottom of the list is not "now".
 *
 * The behaviour worth pinning is what happens when the target is *not* loaded.
 * Before this, a search hit or pinned entry outside the loaded page simply said
 * "not in loaded history" and stopped; now every jump goes through one path
 * that fetches the around-window, detaches the channel, and scrolls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

const toastCalls: Array<{ msg: string; type: string }> = [];
vi.mock("@lib/toast", () => ({
  showToast: (msg: string, type: string) => {
    toastCalls.push({ msg, type });
  },
  initToast: vi.fn(),
}));

// jsdom has no ResizeObserver — MessageList needs one to mount.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

import { createMessageJumper } from "../../src/pages/main-page/MessageJump";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { renderMessage } from "../../src/components/message-list/renderers";
import { renderMentionSegment } from "../../src/components/message-list/content-parser";
import {
  jumpToMessage,
  setMessageJumpHandler,
  hasMessageJumpHandler,
} from "@lib/message-navigation";
import { messagesStore, setAroundMessages } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { channelsStore, setChannels } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { ApiClientError } from "@lib/api";
import type { ApiClient } from "@lib/api";
import type { MessageResponse, ReadyChannel } from "@lib/types";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: null, position: 0 },
  { id: 2, name: "off-topic", type: "text", category: null, position: 1 },
];

function resetStores(): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "alice", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  setChannels(CHANNELS);
  toastCalls.length = 0;
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
    timestamp: "2026-01-15T12:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
}

function response(id: number): MessageResponse {
  return {
    id,
    channel_id: 1,
    user: { id: 1, username: "alice", avatar: null },
    content: `msg ${id}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-01-15T11:00:00Z",
  };
}

/** A stand-in ChannelController: only what the jumper actually touches. */
function fakeCtrl(channelId: number | null, scrollResult = true) {
  const scrollToMessage = vi.fn().mockReturnValue(scrollResult);
  return {
    ctrl: {
      currentChannelId: channelId,
      messageList: { scrollToMessage, mount: vi.fn(), destroy: vi.fn() },
      mountChannel: vi.fn(),
      destroyChannel: vi.fn(),
      openFilePicker: vi.fn(),
    },
    scrollToMessage,
  };
}

function fakeApi(getMessagesAround: unknown): ApiClient {
  return { getMessagesAround } as unknown as ApiClient;
}

/** Resolve immediately instead of waiting for a real animation frame. */
const immediateFrame = (): Promise<void> => Promise.resolve();

/** Store notifications are batched via queueMicrotask — let them land. */
const flushStore = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------

describe("createMessageJumper", () => {
  it("scrolls without fetching when the message is already loaded", async () => {
    const { ctrl, scrollToMessage } = fakeCtrl(1);
    const getMessagesAround = vi.fn();
    const jumper = createMessageJumper({
      api: fakeApi(getMessagesAround),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    await expect(jumper.jumpTo(1, 42)).resolves.toBe(true);

    expect(scrollToMessage).toHaveBeenCalledWith(42);
    expect(getMessagesAround).not.toHaveBeenCalled();
  });

  it("fetches the around-window when the message is not loaded, then scrolls", async () => {
    // First scroll attempt misses (not loaded), second lands after the fetch.
    const scrollToMessage = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage },
    } as unknown as ReturnType<typeof fakeCtrl>["ctrl"];
    const getMessagesAround = vi.fn().mockResolvedValue({
      messages: [response(40), response(41), response(42)],
      has_more_before: true,
      has_more_after: true,
    });
    const jumper = createMessageJumper({
      api: fakeApi(getMessagesAround),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    await expect(jumper.jumpTo(1, 42)).resolves.toBe(true);

    expect(getMessagesAround).toHaveBeenCalledWith(1, 42, { limit: 50 });
    // The window landed in the store and left the channel detached.
    expect(
      messagesStore
        .getState()
        .messagesByChannel.get(1)
        ?.map((m) => m.id),
    ).toEqual([40, 41, 42]);
    expect(messagesStore.getState().detachedChannels.has(1)).toBe(true);
  });

  it("opens the channel first when the target lives elsewhere", async () => {
    const scrollToMessage = vi.fn().mockReturnValue(true);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage },
    } as unknown as ReturnType<typeof fakeCtrl>["ctrl"];
    const jumper = createMessageJumper({
      api: fakeApi(vi.fn()),
      getChannelCtrl: () => ctrl,
      nextFrame: () => {
        // The channel switch is what the frame is waiting for.
        (ctrl as { currentChannelId: number }).currentChannelId = 2;
        return Promise.resolve();
      },
    });

    await jumper.jumpTo(2, 7);

    expect(channelsStore.getState().activeChannelId).toBe(2);
    expect(scrollToMessage).toHaveBeenCalledWith(7);
  });

  it("refuses a channel this user cannot see, without calling the API", async () => {
    const { ctrl } = fakeCtrl(1);
    const getMessagesAround = vi.fn();
    const jumper = createMessageJumper({
      api: fakeApi(getMessagesAround),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    await expect(jumper.jumpTo(999, 42)).resolves.toBe(false);

    expect(getMessagesAround).not.toHaveBeenCalled();
    expect(toastCalls.at(-1)?.msg).toMatch(/isn't available/i);
  });

  it("reports a deleted or missing message from a 404", async () => {
    const scrollToMessage = vi.fn().mockReturnValue(false);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage },
    } as unknown as ReturnType<typeof fakeCtrl>["ctrl"];
    const jumper = createMessageJumper({
      api: fakeApi(
        vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "message not found")),
      ),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    await expect(jumper.jumpTo(1, 42)).resolves.toBe(false);

    expect(toastCalls.at(-1)?.msg).toMatch(/no longer exists/i);
    // A failed jump must not detach the channel from the live tail.
    expect(messagesStore.getState().detachedChannels.has(1)).toBe(false);
  });

  it("surfaces a transport failure without detaching the channel", async () => {
    const scrollToMessage = vi.fn().mockReturnValue(false);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage },
    } as unknown as ReturnType<typeof fakeCtrl>["ctrl"];
    const jumper = createMessageJumper({
      api: fakeApi(vi.fn().mockRejectedValue(new Error("offline"))),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    await expect(jumper.jumpTo(1, 42)).resolves.toBe(false);

    expect(toastCalls.at(-1)?.type).toBe("error");
    expect(messagesStore.getState().detachedChannels.has(1)).toBe(false);
  });

  it("fails loudly when the window comes back without the centre", async () => {
    const scrollToMessage = vi.fn().mockReturnValue(false);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage },
    } as unknown as ReturnType<typeof fakeCtrl>["ctrl"];
    const jumper = createMessageJumper({
      api: fakeApi(
        vi.fn().mockResolvedValue({
          messages: [response(1), response(2)],
          has_more_before: false,
          has_more_after: false,
        }),
      ),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    // Landing silently on a neighbour would look like a successful jump to the
    // wrong message.
    await expect(jumper.jumpTo(1, 42)).resolves.toBe(false);
    expect(toastCalls.at(-1)?.type).toBe("error");
  });

  it("gives up quietly with no mounted channel controller", async () => {
    const jumper = createMessageJumper({
      api: fakeApi(vi.fn()),
      getChannelCtrl: () => null,
      nextFrame: immediateFrame,
    });

    await expect(jumper.jumpTo(1, 42)).resolves.toBe(false);
  });

  it("a stale jump response does not overwrite a newer jump's window (race guard)", async () => {
    // Neither jump ever finds the target already loaded, so both go through
    // the fetch path.
    const scrollToMessage = vi.fn().mockReturnValue(false);
    const ctrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage },
    } as unknown as ReturnType<typeof fakeCtrl>["ctrl"];

    let resolveA: (v: unknown) => void = () => {};
    let resolveB: (v: unknown) => void = () => {};
    const getMessagesAround = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveB = resolve)));

    const jumper = createMessageJumper({
      api: fakeApi(getMessagesAround),
      getChannelCtrl: () => ctrl,
      nextFrame: immediateFrame,
    });

    // A (older, target 10) starts and suspends on its fetch; B (newer,
    // target 20) starts right after — both requests are now in flight.
    const jumpA = jumper.jumpTo(1, 10);
    const jumpB = jumper.jumpTo(1, 20);
    expect(getMessagesAround).toHaveBeenCalledTimes(2);

    // B's response lands first (real network reordering).
    resolveB({ messages: [response(20)], has_more_before: true, has_more_after: true });
    await jumpB;
    expect(
      messagesStore
        .getState()
        .messagesByChannel.get(1)
        ?.map((m) => m.id),
    ).toEqual([20]);

    // A's response lands after B already applied its window — the stale
    // response must not clobber it.
    resolveA({ messages: [response(10)], has_more_before: true, has_more_after: true });
    await jumpA;

    expect(
      messagesStore
        .getState()
        .messagesByChannel.get(1)
        ?.map((m) => m.id),
    ).toEqual([20]);
  });
});

// ---------------------------------------------------------------------------

describe("message-navigation registry", () => {
  it("is a no-op before a page registers a handler", () => {
    expect(hasMessageJumpHandler()).toBe(false);
    expect(() => jumpToMessage(1, 2)).not.toThrow();
  });

  it("routes jumps to the registered handler and unregisters cleanly", () => {
    const handler = vi.fn();
    const unregister = setMessageJumpHandler(handler);

    jumpToMessage(5, 42);
    expect(handler).toHaveBeenCalledWith(5, 42);

    unregister();
    expect(hasMessageJumpHandler()).toBe(false);
  });

  it("a stale unregister does not clear a newer handler", () => {
    const first = vi.fn();
    const unregisterFirst = setMessageJumpHandler(first);
    const second = vi.fn();
    setMessageJumpHandler(second);

    unregisterFirst();

    jumpToMessage(1, 1);
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(hasMessageJumpHandler()).toBe(true);
  });

  afterEach(() => {
    setMessageJumpHandler(() => {})();
  });
});

// ---------------------------------------------------------------------------

describe("reply bar jump wiring", () => {
  function renderRow(msg: Message, all: Message[], opts: Partial<MessageListOptions> = {}) {
    const options = {
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
      ...opts,
    } as MessageListOptions;
    return renderMessage(msg, false, all, options, new AbortController().signal);
  }

  it("clicking the quoted bar jumps to the replied-to message", () => {
    const onJumpToMessage = vi.fn();
    const target = makeMessage({ id: 10, content: "the original" });
    const reply = makeMessage({ id: 11, replyTo: 10 });

    const row = renderRow(reply, [target, reply], { onJumpToMessage });
    const bar = row.querySelector<HTMLElement>(".msg-reply-ref");
    expect(bar).not.toBeNull();
    bar!.click();

    expect(onJumpToMessage).toHaveBeenCalledWith(10);
  });

  it("stays clickable when the replied-to message is outside the window", () => {
    // The id is known even though the row is not loaded — that is exactly the
    // case the around-window fetch exists for.
    const onJumpToMessage = vi.fn();
    const reply = makeMessage({ id: 11, replyTo: 999 });

    const row = renderRow(reply, [reply], { onJumpToMessage });
    const bar = row.querySelector<HTMLElement>(".msg-reply-ref");
    expect(bar?.textContent).toMatch(/unknown message/i);
    expect(bar?.getAttribute("data-reply-to")).toBe("999");

    bar!.click();
    expect(onJumpToMessage).toHaveBeenCalledWith(999);
  });

  it("is keyboard reachable and activates on Enter", () => {
    const onJumpToMessage = vi.fn();
    const target = makeMessage({ id: 10 });
    const reply = makeMessage({ id: 11, replyTo: 10 });

    const row = renderRow(reply, [target, reply], { onJumpToMessage });
    const bar = row.querySelector<HTMLElement>(".msg-reply-ref")!;
    expect(bar.getAttribute("role")).toBe("button");
    expect(bar.getAttribute("tabindex")).toBe("0");

    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onJumpToMessage).toHaveBeenCalledWith(10);
  });

  it("does nothing when no jump handler is wired", () => {
    const reply = makeMessage({ id: 11, replyTo: 10 });
    const row = renderRow(reply, [reply]);
    expect(() => row.querySelector<HTMLElement>(".msg-reply-ref")!.click()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("Copy Message Link action", () => {
  it("copies the owncord:// permalink for the row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const msg = makeMessage({ id: 42, channelId: 7 });
    const row = renderMessage(
      msg,
      false,
      [msg],
      {
        channelId: 7,
        channelName: "general",
        currentUserId: 1,
        onScrollTop: vi.fn(),
        onReplyClick: vi.fn(),
        onEditClick: vi.fn(),
        onDeleteClick: vi.fn(),
        onReactionClick: vi.fn(),
        onPinClick: vi.fn(),
      } as MessageListOptions,
      new AbortController().signal,
    );

    const btn = row.querySelector<HTMLButtonElement>('[data-testid="msg-copy-link-42"]');
    expect(btn).not.toBeNull();
    btn!.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("owncord://message/7/42");
  });
});

// ---------------------------------------------------------------------------

describe("permalink chips in message content", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a pasted permalink as a compact chip naming the channel", () => {
    container.appendChild(renderMentionSegment("see owncord://message/2/99 for context"));

    const chip = container.querySelector<HTMLElement>(".message-link-chip");
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".mlc-channel")?.textContent).toBe("#off-topic");
    expect(chip!.querySelector(".mlc-action")?.textContent).toBe("Jump");
    expect(chip!.getAttribute("data-channel-id")).toBe("2");
    expect(chip!.getAttribute("data-message-id")).toBe("99");
    // The raw URL is gone — the chip replaced it, not decorated it.
    expect(container.textContent).not.toContain("owncord://");
  });

  it("clicking the chip routes through the jump registry", () => {
    const handler = vi.fn();
    const unregister = setMessageJumpHandler(handler);
    container.appendChild(renderMentionSegment("owncord://message/2/99"));

    container.querySelector<HTMLElement>(".message-link-chip")!.click();

    expect(handler).toHaveBeenCalledWith(2, 99);
    unregister();
  });

  it("activates on Enter for keyboard users", () => {
    const handler = vi.fn();
    const unregister = setMessageJumpHandler(handler);
    container.appendChild(renderMentionSegment("owncord://message/1/5"));

    const chip = container.querySelector<HTMLElement>(".message-link-chip")!;
    expect(chip.getAttribute("role")).toBe("link");
    expect(chip.getAttribute("tabindex")).toBe("0");
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(handler).toHaveBeenCalledWith(1, 5);
    unregister();
  });

  it("leaves a link to an invisible channel as plain text", () => {
    container.appendChild(renderMentionSegment("owncord://message/404/1"));

    expect(container.querySelector(".message-link-chip")).toBeNull();
    expect(container.textContent).toBe("owncord://message/404/1");
  });

  it("leaves a malformed permalink as plain text", () => {
    container.appendChild(renderMentionSegment("owncord://message/abc/1"));

    expect(container.querySelector(".message-link-chip")).toBeNull();
    expect(container.textContent).toBe("owncord://message/abc/1");
  });

  it("chips several permalinks in one message", () => {
    container.appendChild(renderMentionSegment("owncord://message/1/5 and owncord://message/2/6"));

    expect(container.querySelectorAll(".message-link-chip")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("Jump to Present pill", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;

  function baseOptions(overrides: Partial<MessageListOptions> = {}): MessageListOptions {
    return {
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
      ...overrides,
    } as MessageListOptions;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list.destroy?.();
    container.remove();
  });

  it("stays hidden while the window is attached to the live tail", () => {
    list = createMessageList(baseOptions());
    list.mount(container);

    const pill = container.querySelector('[data-testid="jump-to-present"]');
    expect(pill).not.toBeNull();
    expect(pill!.classList.contains("visible")).toBe(false);
  });

  it("appears when an around-window detaches the channel", async () => {
    list = createMessageList(baseOptions());
    list.mount(container);

    setAroundMessages(1, [response(1), response(2)], true, true);
    await flushStore();

    const pill = container.querySelector('[data-testid="jump-to-present"]')!;
    expect(pill.classList.contains("visible")).toBe(true);
  });

  it("is already visible when mounting into an detached channel", () => {
    setAroundMessages(1, [response(1)], true, true);

    list = createMessageList(baseOptions());
    list.mount(container);

    expect(
      container.querySelector('[data-testid="jump-to-present"]')!.classList.contains("visible"),
    ).toBe(true);
  });

  it("hides again once the channel reattaches", async () => {
    list = createMessageList(baseOptions());
    list.mount(container);
    setAroundMessages(1, [response(1)], true, true);
    await flushStore();
    expect(
      container.querySelector('[data-testid="jump-to-present"]')!.classList.contains("visible"),
    ).toBe(true);

    setAroundMessages(1, [response(1)], true, false);
    await flushStore();

    expect(
      container.querySelector('[data-testid="jump-to-present"]')!.classList.contains("visible"),
    ).toBe(false);
  });

  it("clicking it asks the controller to reload the tail", async () => {
    const onJumpToPresent = vi.fn();
    list = createMessageList(baseOptions({ onJumpToPresent }));
    list.mount(container);
    setAroundMessages(1, [response(1)], true, true);
    await flushStore();

    container.querySelector<HTMLButtonElement>('[data-testid="jump-to-present"]')!.click();

    expect(onJumpToPresent).toHaveBeenCalledTimes(1);
  });

  it("tracks only its own channel", async () => {
    list = createMessageList(baseOptions());
    list.mount(container);

    setAroundMessages(2, [response(1)], true, true);
    await flushStore();

    expect(
      container.querySelector('[data-testid="jump-to-present"]')!.classList.contains("visible"),
    ).toBe(false);
  });
});
