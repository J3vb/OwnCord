/**
 * WP 3A-8 review fixes: the inline editor across window slides, a failed
 * editor load, a quiet (no-focus) restore, and an emptied list whose older
 * page fails to load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loader = vi.hoisted(() => ({ failLoad: false }));
vi.mock("../../src/features/messaging/inlineEditLoader", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/features/messaging/inlineEditLoader")>();
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
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { setChannels, setActiveChannel, setRoles, channelsStore } from "@stores/channels.store";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";
import { makeListOptions, stubTallRowLayout } from "../helpers/messageListHarness";
import { buildMessage } from "../helpers/messageFactory";

const CHANNEL_ID = 1;
const ME = { id: 1, username: "Alice", avatar: null };

function makeMessage(id: number, over: Partial<Message> = {}): Message {
  return buildMessage(
    { id, ...over },
    {
      channelId: CHANNEL_ID,
      user: ME,
      timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    },
  );
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

describe("MessageList — inline editor lifecycle", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let restoreLayout: () => void;

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
    resetServerCapabilities();
    resetMessagesState();
    resetMembersState();
    setChannels([]);
    setActiveChannel(null);
    restoreLayout = stubTallRowLayout();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeListOptions({ channelId: CHANNEL_ID, onEditEnd: vi.fn() });
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    restoreLayout();
  });

  it("refuses to edit a sticker message", () => {
    setMessages([
      makeMessage(1, {
        content: "[Sticker: Wave]",
        sticker: { id: null, name: "Wave", url: null },
      }),
    ]);
    mount();
    expect(list!.startEdit(1)).toBe(false);
    expect(editor(1)).toBeNull();
  });

  it("the edit box shows id tokens as @name and converts untouched spans back on save", async () => {
    applyReadyCapabilities({ id_mentions: true });
    membersStore.setState(() => ({
      members: new Map([
        [10, { id: 10, username: "bob", avatar: null, role: "member", status: "online" as const }],
      ]),
      typingUsers: new Map(),
    }));
    setRoles([{ id: 5, name: "Mods", color: null, permissions: 0 }]);
    channelsStore.flush();
    setMessages([makeMessage(1, { content: "hi <@10> <@&5> <@77>" })]);
    mount();

    expect(list!.startEdit(1)).toBe(true);
    await vi.waitFor(() => expect(editor(1)).not.toBeNull());
    expect(editor(1)!.value).toBe("hi @bob @Mods <@77>");

    // The unknown id stays as typed; the user changes one span and the text.
    editor(1)!.value = "yo @bob @Mod <@77>";
    editor(1)!.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLElement>("[data-testid='msg-edit-save-1']")!.click();
    expect(options.onEditSave).toHaveBeenCalledWith(1, "yo <@10> @Mod <@77>");
  });

  it("refuses an edit that is within the limit as shown but over it once mentions expand", async () => {
    applyReadyCapabilities({ id_mentions: true });
    membersStore.setState(() => ({
      members: new Map([
        [
          123456789012,
          {
            id: 123456789012,
            username: "Zed",
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
      typingUsers: new Map(),
    }));
    setMessages([makeMessage(1, { content: "<@123456789012> <@123456789012> short" })]);
    mount();
    expect(list!.startEdit(1)).toBe(true);
    await vi.waitFor(() => expect(editor(1)).not.toBeNull());
    expect(editor(1)!.value).toBe("@Zed @Zed short");

    const draft = `@Zed @Zed ${"a".repeat(3989)}`;
    editor(1)!.value = draft;
    editor(1)!.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLElement>("[data-testid='msg-edit-save-1']")!.click();
    expect(options.onEditSave).not.toHaveBeenCalled();
    expect(editor(1)!.value).toBe(draft);
    expect(container.querySelector(".msg-inline-edit-error")?.textContent).toContain("4000");
  });

  it("saves the shown text as is without the id_mentions capability", async () => {
    membersStore.setState(() => ({
      members: new Map([
        [10, { id: 10, username: "bob", avatar: null, role: "member", status: "online" as const }],
      ]),
      typingUsers: new Map(),
    }));
    setMessages([makeMessage(1, { content: "hi <@10>" })]);
    mount();
    expect(list!.startEdit(1)).toBe(true);
    await vi.waitFor(() => expect(editor(1)).not.toBeNull());
    expect(editor(1)!.value).toBe("hi @bob");
    container.querySelector<HTMLElement>("[data-testid='msg-edit-save-1']")!.click();
    expect(options.onEditSave).toHaveBeenCalledWith(1, "hi @bob");
  });

  it("converts a restored edit text (a failed save) too", async () => {
    applyReadyCapabilities({ id_mentions: true });
    membersStore.setState(() => ({
      members: new Map([
        [10, { id: 10, username: "bob", avatar: null, role: "member", status: "online" as const }],
      ]),
      typingUsers: new Map(),
    }));
    setMessages([makeMessage(1, { content: "hi <@10>" })]);
    mount();
    expect(list!.startEdit(1, "hey <@10> again")).toBe(true);
    await vi.waitFor(() => expect(editor(1)).not.toBeNull());
    expect(editor(1)!.value).toBe("hey @bob again");
    container.querySelector<HTMLElement>("[data-testid='msg-edit-save-1']")!.click();
    expect(options.onEditSave).toHaveBeenCalledWith(1, "hey <@10> again");
  });

  it("re-reads role pills when the roster changes", async () => {
    setRoles([{ id: 5, name: "Mods", color: null, permissions: 0 }]);
    channelsStore.flush();
    setMessages([makeMessage(1, { content: "yo <@&5>" })]);
    mount();
    await settle();
    expect(row(1)!.querySelector(".mention-role")?.textContent).toBe("@Mods");
    setRoles([{ id: 5, name: "Staff", color: null, permissions: 0 }]);
    channelsStore.flush();
    await vi.waitFor(() =>
      expect(row(1)!.querySelector(".mention-role")?.textContent).toBe("@Staff"),
    );
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

  it("an editor that held focus gets it back after a jump away and back (full rebuild)", async () => {
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

    await scrollTo(0);
    expect(row(id)).toBeNull();
    // Jump back in big steps, so the window is rebuilt rather than slid.
    let top = 0;
    while (row(id) === null && top < 6000) {
      top += 1500;
      await scrollTo(top);
    }

    expect(row(id)).not.toBeNull();
    expect(editor(id)).toBe(textarea);
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
