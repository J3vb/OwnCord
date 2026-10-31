// B9-22: a virtualized rebuild must put focus back on the control it was on, so
// a keyboard user reading a long channel does not lose their place when the
// window materializes rows around them (Q1 focus: stable location through
// async update/removal).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import {
  makeListOptions,
  makeMessage,
  resetStores,
  setMessages,
} from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";

describe("MessageList focus retention across a virtualized rebuild", () => {
  let container: HTMLDivElement;
  let options: MessageListOptions;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeListOptions();
    setMessages(1, [
      makeMessage({ id: 1, user: { id: 2, username: "Bob", avatar: null } }),
      makeMessage({ id: 2, user: { id: 2, username: "Bob", avatar: null } }),
    ]);
  });

  afterEach(() => {
    container.remove();
    resetStores();
  });

  it("restores focus to the action button on its row after a full rebuild", async () => {
    const list = createMessageList(options);
    list.mount(container);

    const replyBtn = container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-2']");
    expect(replyBtn).not.toBeNull();
    replyBtn!.focus();
    expect(document.activeElement).toBe(replyBtn);

    // An edit to an existing row is not a pure suffix append, so it forces the
    // full rebuild path (renderAll → renderWindow REBUILD) that clears and
    // re-renders every row, replacing the focused node. setState batches on a
    // microtask, so wait for it to run.
    const msgs = messagesStore.getState().messagesByChannel.get(1)!;
    setMessages(
      1,
      msgs.map((m) =>
        m.id === 2 ? { ...m, content: "edited", editedAt: "2024-01-15T12:01:00Z" } : m,
      ),
    );
    await messagesStore.flush();

    const restored = container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-2']");
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(replyBtn);
    expect(document.activeElement).toBe(restored);

    list.destroy?.();
  });

  it("restores focus to the same reaction chip, not the row's first control", async () => {
    const tada = (): HTMLElement | undefined =>
      [...container.querySelectorAll<HTMLElement>("[data-testid='message-2'] .reaction-chip")].find(
        (c) => c.dataset.emoji === "🎉",
      );
    const reactions = [
      { emoji: "👍", count: 1, me: false },
      { emoji: "🎉", count: 1, me: false },
    ];
    setMessages(1, [
      makeMessage({ id: 1, user: { id: 2, username: "Bob", avatar: null } }),
      makeMessage({ id: 2, user: { id: 2, username: "Bob", avatar: null }, reactions }),
    ]);
    const list = createMessageList(options);
    list.mount(container);

    const chip = tada();
    expect(chip).toBeDefined();
    chip!.focus();

    // A reaction update rewrites an existing row, forcing the full rebuild.
    const msgs = messagesStore.getState().messagesByChannel.get(1)!;
    setMessages(
      1,
      msgs.map((m) =>
        m.id === 2 ? { ...m, reactions: [reactions[0]!, { emoji: "🎉", count: 2, me: true }] } : m,
      ),
    );
    await messagesStore.flush();

    const restored = tada();
    expect(restored).not.toBe(chip);
    expect(document.activeElement).toBe(restored);

    list.destroy?.();
  });

  it("restores focus without scrolling the list to the focused row", async () => {
    const list = createMessageList(options);
    list.mount(container);
    container.querySelector<HTMLButtonElement>("[data-testid='msg-reply-2']")!.focus();

    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    const msgs = messagesStore.getState().messagesByChannel.get(1)!;
    setMessages(
      1,
      msgs.map((m) =>
        m.id === 2 ? { ...m, content: "edited", editedAt: "2024-01-15T12:01:00Z" } : m,
      ),
    );
    await messagesStore.flush();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    focusSpy.mockRestore();

    list.destroy?.();
  });

  it("leaves focus alone when it was outside the rendered window", async () => {
    const list = createMessageList(options);
    list.mount(container);

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const msgs = messagesStore.getState().messagesByChannel.get(1)!;
    setMessages(
      1,
      msgs.map((m) =>
        m.id === 2 ? { ...m, content: "edited", editedAt: "2024-01-15T12:01:00Z" } : m,
      ),
    );
    await messagesStore.flush();

    expect(document.activeElement).toBe(outside);

    outside.remove();
    list.destroy?.();
  });
});
