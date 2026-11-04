import { vi, beforeEach, afterEach } from "vitest";
import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "./messageFactory";
import { membersStore } from "@stores/members.store";
import { resetMessagesState, resetMembersState } from "./storeResets";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { signInAs } from "./storeSeeds";
import { seedLoadedMessages } from "./readPointerFixtures";
import type { ReadyChannel } from "@lib/types";

export function resetStores(): void {
  resetMessagesState();
  resetMembersState();
}

export function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return buildMessage(overrides);
}

export const setMessages = seedLoadedMessages;

/** setMessages, then let the store notify its subscribers. */
export function setMessagesFlushed(channelId: number, messages: readonly Message[]): void {
  setMessages(channelId, messages);
  messagesStore.flush();
}

export function setDetached(channelId: number, detached: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Set(prev.detachedChannels);
    if (detached) next.add(channelId);
    else next.delete(channelId);
    return { ...prev, detachedChannels: next };
  });
}

/**
 * Seed the channel list with one text channel carrying `unread` unread messages
 * (and the read `pointer`, when given), then open it the way the app does: the
 * badge clears and the count and pointer are snapshotted.
 */
export function openChannel(channelId: number, unread: number, pointer?: number): void {
  const channel: ReadyChannel = {
    id: channelId,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unread_count: unread,
    mention_count: 0,
    ...(pointer !== undefined ? { last_read_message_id: pointer } : {}),
  };
  setChannels([channel]);
  setActiveChannel(channelId);
}

export function setHasMore(channelId: number, value: boolean): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.hasMore);
    next.set(channelId, value);
    return { ...prev, hasMore: next };
  });
}

export function setHistoryLoadState(channelId: number, value: "loading" | "error"): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.historyLoadState);
    next.set(channelId, value);
    return { ...prev, historyLoadState: next };
  });
}

/** Fresh options for a list on channel 1 as user 1, with every callback a new spy. */
export function makeListOptions(overrides: Partial<MessageListOptions> = {}): MessageListOptions {
  return {
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
    ...overrides,
  };
}

/** Resolves after the next animation frame. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** resetStores plus an emptied channel list, so an unread count cannot leak a NEW divider. */
export function resetStoresAndChannels(): void {
  resetStores();
  setChannels([]);
  setActiveChannel(null);
}

/**
 * jsdom lays nothing out: stubs a tall scroller and fixed row heights (100 for a
 * message, 32 otherwise). Returns the function that restores the originals.
 */
export function stubTallRowLayout(): () => void {
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
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
  return () => {
    for (const [name, d] of [
      ["scrollHeight", scrollHeight],
      ["offsetHeight", offsetHeight],
    ] as const) {
      if (d) Object.defineProperty(HTMLElement.prototype, name, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  };
}

/**
 * jsdom lays nothing out, so every scroll gap reads 0 and "near the bottom" is
 * always true. Stubs `scrollHeight` (a number, or a getter read on each access);
 * returns the function that restores the original.
 */
export function stubScrollHeight(height: number | (() => number)): () => void {
  const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(): number {
      return typeof height === "number" ? height : height();
    },
  });
  return () => {
    if (saved) Object.defineProperty(HTMLElement.prototype, "scrollHeight", saved);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  };
}

/**
 * Stubs `scrollHeight` and/or `clientHeight` on every element (jsdom reports 0 for both);
 * returns the function that restores the originals.
 */
export function stubElementHeights(
  heights: Partial<Record<"scrollHeight" | "clientHeight", number>>,
): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [prop, value] of Object.entries(heights)) {
    saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  return () => {
    for (const [prop, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  };
}

export type MessageListComponent = ReturnType<typeof createMessageList>;

/** Registers the shared beforeEach/afterEach for every messageList test file. */
export function useMessageListHarness(
  bind: (wired: {
    container: HTMLDivElement;
    options: MessageListOptions;
    msgList: MessageListComponent;
  }) => void,
  current: () => MessageListComponent,
): void {
  let container: HTMLDivElement;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeListOptions();
    const msgList = createMessageList(options);
    bind({ container, options, msgList });
  });

  afterEach(() => {
    current().destroy?.();
    container.remove();
  });
}

/** Replaces the member list with a single online member. */
export function seedMember(id: number, username: string, role = "member"): void {
  membersStore.setState(() => ({
    members: new Map([[id, { id, username, avatar: null, role, status: "online" as const }]]),
    typingUsers: new Map(),
    roleRevision: 0,
  }));
}

/** Adds an online member and flushes, as a live member_join would. */
export function joinMember(id: number, username: string): void {
  membersStore.setState((prev) => {
    const next = new Map(prev.members);
    next.set(id, { id, username, avatar: null, role: "member", status: "online" as const });
    return { ...prev, members: next, roleRevision: (prev.roleRevision ?? 0) + 1 };
  });
  membersStore.flush();
}

/** Signs in as user 99, who is not an author in the fixtures. */
export function signInAsViewer(): void {
  signInAs(
    { id: 99, username: "me", avatar: null, role: "member" },
    { token: "t", serverName: null },
  );
}

export interface WiredMessageList {
  container: HTMLDivElement;
  options: MessageListOptions;
  msgList: MessageListComponent;
}

/** useMessageListHarness with the wired pieces kept on one object; tests may replace `msgList`. */
export function useWiredMessageList(): WiredMessageList {
  const wired = {} as WiredMessageList;
  useMessageListHarness(
    (w) => Object.assign(wired, w),
    () => wired.msgList,
  );
  return wired;
}
