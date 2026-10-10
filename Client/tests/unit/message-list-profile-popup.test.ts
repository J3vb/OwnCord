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

const { createPopupMock, destroyMock } = vi.hoisted(() => {
  const destroy = vi.fn();
  return {
    destroyMock: destroy,
    createPopupMock: vi.fn((_opts: unknown) => ({
      mount: vi.fn(),
      destroy,
      isOpen: () => true,
    })),
  };
});
vi.mock("@components/UserProfilePopup", () => ({ createUserProfilePopup: createPopupMock }));

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore, updateMemberRole } from "@stores/members.store";
import type { Member } from "@stores/members.store";

function member(id: number, username: string): Member {
  return { id, username, avatar: null, role: "member", status: "online" };
}

function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return {
    channelId: 1,
    user: { id: 7, username: "seven", avatar: null },
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

/** The user id the most recent popup was opened for. */
function openedFor(): number | undefined {
  const opts = createPopupMock.mock.calls.at(-1)?.[0] as { user: { id: number } } | undefined;
  return opts?.user.id;
}

/** Wait for the lazy `import()` of the popup module to settle. */
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(createPopupMock).toHaveBeenCalled());
}

/** Give a (wrongly) pending lazy open every chance to land. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MessageList profile popup", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;

  beforeEach(() => {
    createPopupMock.mockClear();
    destroyMock.mockClear();
    membersStore.setState(() => ({
      members: new Map([
        [7, member(7, "seven")],
        [9, member(9, "nine")],
      ]),
      typingUsers: new Map(),
    }));
    messagesStore.setState(() => ({
      messagesByChannel: new Map([
        [1, [makeMessage({ id: 1, content: "hello @nine and @everyone", mentions: [9] })]],
      ]),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    const options: MessageListOptions = {
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
    list = createMessageList(options);
    list.mount(container);
  });

  afterEach(() => {
    list.destroy?.();
    container.remove();
  });

  it("opens the author's profile when the name is clicked, anchored at the click", async () => {
    const author = container.querySelector<HTMLElement>(".msg-author");
    expect(author).not.toBeNull();
    author?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 120, clientY: 80 }));
    await settle();
    expect(openedFor()).toBe(7);
    expect(createPopupMock.mock.calls[0]?.[0]).toMatchObject({ anchorX: 120, anchorY: 80 });
  });

  it("opens the author's profile when the avatar is clicked", async () => {
    container.querySelector<HTMLElement>(".msg-avatar")?.click();
    await settle();
    expect(openedFor()).toBe(7);
  });

  it("opens the mentioned user's profile when an @mention chip is clicked", async () => {
    const chip = container.querySelector<HTMLElement>('.mention[data-user-id="9"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("role")).toBe("button");
    expect(chip?.getAttribute("tabindex")).toBe("0");
    chip?.click();
    await settle();
    expect(openedFor()).toBe(9);
  });

  it("renders a mention inside a masked link as part of the link, not as a second control", async () => {
    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map([
        [1, [makeMessage({ id: 2, content: "[@nine](https://example.com/x)", mentions: [9] })]],
      ]),
    }));
    list.destroy?.();
    container.replaceChildren();
    list = createMessageList({
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    });
    list.mount(container);

    const chip = container.querySelector<HTMLElement>('a[target="_blank"] .mention');
    expect(chip).not.toBeNull();
    // One control only: no nested button for Tab or a screen reader to find...
    expect(chip?.hasAttribute("role")).toBe(false);
    expect(chip?.hasAttribute("tabindex")).toBe(false);
    expect(chip?.hasAttribute("data-user-id")).toBe(false);

    // ...and a click on it is the link's click, never a profile open.
    createPopupMock.mockClear();
    chip?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(createPopupMock).not.toHaveBeenCalled();
  });

  it("keeps a masked-link mention non-interactive after a member change re-resolves mentions", async () => {
    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map([
        [1, [makeMessage({ id: 2, content: "[@nine](https://example.com/x)", mentions: [9] })]],
      ]),
    }));
    list.destroy?.();
    container.replaceChildren();
    list = createMessageList({
      channelId: 1,
      channelName: "general",
      currentUserId: 1,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    });
    list.mount(container);
    const chipOf = (): HTMLElement | null =>
      container.querySelector<HTMLElement>('a[target="_blank"] .mention');
    expect(chipOf()?.hasAttribute("role")).toBe(false);

    // A role change bumps roleRevision, which re-resolves every rendered mention.
    updateMemberRole(9, "admin");
    membersStore.flush();
    await flush();

    const chip = chipOf();
    expect(chip).not.toBeNull();
    expect(chip?.hasAttribute("role")).toBe(false);
    expect(chip?.hasAttribute("tabindex")).toBe(false);
    expect(chip?.hasAttribute("data-user-id")).toBe(false);
  });

  it("ignores @everyone chips, which name no user", async () => {
    // Rendered only when the server honoured it; either way it must never open a profile.
    container.querySelector<HTMLElement>(".mention-everyone")?.click();
    await flush();
    expect(createPopupMock).not.toHaveBeenCalled();
  });

  it("opens on Enter and Space from the focused author", async () => {
    const author = container.querySelector<HTMLElement>(".msg-author");
    author?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(openedFor()).toBe(7);
    createPopupMock.mockClear();
    author?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await settle();
    expect(openedFor()).toBe(7);
  });

  it("opens on Enter from a focused mention chip", async () => {
    const chip = container.querySelector<HTMLElement>('.mention[data-user-id="9"]');
    chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(openedFor()).toBe(9);
  });

  it("does not open for other keys or for clicks elsewhere in the row", async () => {
    const author = container.querySelector<HTMLElement>(".msg-author");
    author?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    container.querySelector<HTMLElement>(".msg-text")?.click();
    container.querySelector<HTMLElement>(".msg-time")?.click();
    container.querySelector<HTMLElement>(".message")?.click();
    await flush();
    expect(createPopupMock).not.toHaveBeenCalled();
  });

  it("closes the popup it opened when the list is destroyed", async () => {
    container.querySelector<HTMLElement>(".msg-author")?.click();
    await settle();
    list.destroy?.();
    expect(destroyMock).toHaveBeenCalled();
  });
});
