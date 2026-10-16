/**
 * WP 3A-8 review fixes: the inline editor across window slides, a failed
 * editor load, a quiet (no-focus) restore, and an emptied list whose older
 * page fails to load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const loader = vi.hoisted(() => ({ failLoad: false }));
vi.mock("@components/message-list/inline-edit-loader", async (importActual) => {
  const actual = await importActual<typeof import("@components/message-list/inline-edit-loader")>();
  return {
    ...actual,
    withInlineEdit: (use: Parameters<typeof actual.withInlineEdit>[0], onError?: () => void) => {
      if (loader.failLoad) onError?.();
      else actual.withInlineEdit(use, onError);
    },
  };
});

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";

const CHANNEL_ID = 1;
const ME = { id: 1, username: "Alice", avatar: null };

function makeMessage(id: number, over: Partial<Message> = {}): Message {
  return {
    id,
    channelId: CHANNEL_ID,
    user: ME,
    content: `Message ${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...over,
  };
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

describe("MessageList — inline editor lifecycle (WP 3A-8 review)", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let scrollHeight: PropertyDescriptor | undefined;
  let offsetHeight: PropertyDescriptor | undefined;

  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid='message-${id}']`);
  const editor = (id: number): HTMLTextAreaElement | null =>
    container.querySelector<HTMLTextAreaElement>(`[data-testid='msg-edit-input-${id}']`);
  const rootEl = (): HTMLElement => container.querySelector<HTMLElement>(".messages-container")!;
  const mount = (): void => {
    list = createMessageList(options);
    list.mount(container);
  };
  /** Let the mount's own scroll-to-bottom and measuring passes finish. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
  const scrollTo = async (top: number): Promise<void> => {
    rootEl().scrollTop = top;
    rootEl().dispatchEvent(new Event("scroll"));
    messagesStore.flush();
    await new Promise((r) => setTimeout(r, 25));
  };

  beforeEach(() => {
    loader.failLoad = false;
    messagesStore.setState(() => ({
      messagesByChannel: new Map(),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
    setChannels([]);
    setActiveChannel(null);
    scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    // jsdom lays nothing out: a tall scroller, and fixed row heights.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 100_000,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains("message") ? 100 : 32;
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    options = {
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
    };
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    for (const [name, d] of [
      ["scrollHeight", scrollHeight],
      ["offsetHeight", offsetHeight],
    ] as const) {
      if (d) Object.defineProperty(HTMLElement.prototype, name, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it("a failed editor load leaves nothing editing, so the next attempt can start", async () => {
    setMessages([1, 2, 3].map((id) => makeMessage(id)));
    mount();
    loader.failLoad = true;

    expect(list!.startEdit(2)).toBe(true);
    await vi.waitFor(() => expect(list!.isEditing()).toBe(false));
    expect(editor(2)).toBeNull();

    loader.failLoad = false;
    expect(list!.startEdit(2)).toBe(true);
    await vi.waitFor(() => expect(editor(2)).not.toBeNull());
    expect(list!.isEditing()).toBe(true);
  });

  it("startEdit with focus:false opens the editor without taking focus or moving the view", async () => {
    setMessages(Array.from({ length: 60 }, (_, i) => makeMessage(i + 1)));
    mount();
    await settle();
    await scrollTo(3300);
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    const before = rootEl().scrollTop;
    // A row far outside the window: a focusing start would reveal it.
    expect(list!.startEdit(2, "restored text", { focus: false })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    await vi.waitFor(() => expect(list!.isEditing()).toBe(true));

    expect(document.activeElement).toBe(composer);
    expect(rootEl().scrollTop).toBe(before);
    composer.remove();
  });

  it("a visible row's editor reopened with focus:false keeps the composer's focus", async () => {
    setMessages([1, 2, 3].map((id) => makeMessage(id)));
    mount();
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();

    expect(list!.startEdit(2, "restored text", { focus: false })).toBe(true);
    await vi.waitFor(() => expect(editor(2)).not.toBeNull());

    expect(editor(2)!.value).toBe("restored text");
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("an editor that held focus gets it back when its row scrolls out of the window and back", async () => {
    setMessages(Array.from({ length: 60 }, (_, i) => makeMessage(i + 1)));
    mount();
    await settle();
    await scrollTo(3300);
    const visibleIds = [
      ...container.querySelectorAll<HTMLElement>(".virtual-content > .message"),
    ].map((el) => Number(el.dataset.testid!.replace("message-", "")));
    const id = visibleIds[visibleIds.length - 2]!;
    expect(list!.startEdit(id)).toBe(true);
    await vi.waitFor(() => expect(editor(id)).not.toBeNull());
    const textarea = editor(id)!;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    // Scroll up in small steps until the row has left the rendered window...
    let top = 3300;
    while (row(id) !== null && top > 0) {
      top -= 100;
      await scrollTo(top);
    }
    expect(row(id)).toBeNull();
    // ...and back until it is rendered again.
    while (row(id) === null && top < 6000) {
      top += 100;
      await scrollTo(top);
    }

    expect(row(id)).not.toBeNull();
    expect(editor(id)).toBe(textarea);
    expect(row(id)!.contains(textarea)).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("does not steal focus back from another field when the row returns", async () => {
    setMessages(Array.from({ length: 60 }, (_, i) => makeMessage(i + 1)));
    mount();
    await settle();
    await scrollTo(3300);
    const visibleIds = [
      ...container.querySelectorAll<HTMLElement>(".virtual-content > .message"),
    ].map((el) => Number(el.dataset.testid!.replace("message-", "")));
    const id = visibleIds[visibleIds.length - 2]!;
    expect(list!.startEdit(id)).toBe(true);
    await vi.waitFor(() => expect(editor(id)).not.toBeNull());
    editor(id)!.focus();

    let top = 3300;
    while (row(id) !== null && top > 0) {
      top -= 100;
      await scrollTo(top);
    }
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    while (row(id) === null && top < 6000) {
      top += 100;
      await scrollTo(top);
    }

    expect(document.activeElement).toBe(other);
    other.remove();
  });

  describe("every loaded row deleted, and the older page fails", () => {
    it("shows the load error with Retry instead of loading forever, and Retry loads again", async () => {
      setMessages([1, 2].map((id) => makeMessage(id, { deleted: true })));
      messagesStore.setState((prev) => ({
        ...prev,
        hasMore: new Map(prev.hasMore).set(CHANNEL_ID, true),
      }));
      options = {
        ...options,
        // A failed fetch settles with nothing prepended.
        onScrollTop: vi.fn(() => Promise.resolve()),
      };

      mount();
      await vi.waitFor(() =>
        expect(container.querySelector(".messages-load-error")).not.toBeNull(),
      );

      expect(container.querySelector(".messages-loading")).toBeNull();
      expect(options.onScrollTop).toHaveBeenCalledTimes(1);

      container.querySelector<HTMLButtonElement>(".messages-load-error button")!.click();
      expect(options.onScrollTop).toHaveBeenCalledTimes(2);
    });
  });
});
