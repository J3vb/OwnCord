// A reaction or pin change redraws only the row's reactions and pin button, so
// media and revealed spoilers inside the row survive; any other change rebuilds.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createMessageList } from "../../src/features/messaging/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import {
  makeListOptions,
  makeMessage,
  resetStores,
  setMessages,
} from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";
import { hoverRows } from "../helpers/hoverRows";

const bob = { id: 2, username: "Bob", avatar: null };

async function edit(change: (m: Message) => Message): Promise<void> {
  const msgs = messagesStore.getState().messagesByChannel.get(1)!;
  setMessages(
    1,
    msgs.map((m) => (m.id === 2 ? change(m) : m)),
  );
  await messagesStore.flush();
}

describe("MessageList reaction and pin patch", () => {
  let container: HTMLDivElement;

  const row = (): HTMLElement => container.querySelector<HTMLElement>("[data-testid='message-2']")!;
  const chipFor = (emoji: string): HTMLElement | undefined =>
    [...row().querySelectorAll<HTMLElement>(".reaction-chip")].find(
      (c) => c.dataset.emoji === emoji,
    );

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    setMessages(1, [
      makeMessage({ id: 1, user: bob }),
      makeMessage({ id: 2, user: bob, reactions: [{ emoji: "🎉", count: 1, me: false }] }),
    ]);
  });

  afterEach(() => {
    container.remove();
    resetStores();
  });

  it("keeps the row and its media on a reaction-only change, with focus on the chip", async () => {
    const list = createMessageList(makeListOptions());
    list.mount(container);
    const el = row();
    const video = document.createElement("video");
    el.appendChild(video);
    const chip = chipFor("🎉")!;
    chip.focus();

    await edit((m) => ({ ...m, reactions: [{ emoji: "🎉", count: 2, me: true }] }));

    expect(row()).toBe(el);
    expect(video.isConnected).toBe(true);
    const next = chipFor("🎉")!;
    expect(next).not.toBe(chip);
    expect(next.querySelector(".rc-count")?.textContent).toBe("2");
    expect(document.activeElement).toBe(next);
    list.destroy?.();
  });

  it("keeps the row on a pin change", async () => {
    const list = createMessageList(makeListOptions());
    list.mount(container);
    hoverRows(container);
    const el = row();
    const video = document.createElement("video");
    el.appendChild(video);

    await edit((m) => ({ ...m, pinned: true }));

    expect(row()).toBe(el);
    expect(video.isConnected).toBe(true);
    list.destroy?.();
  });

  it("adds and removes the reactions node in place", async () => {
    const list = createMessageList(makeListOptions());
    list.mount(container);
    const el = row();
    await edit((m) => ({ ...m, reactions: [] }));
    expect(row()).toBe(el);
    expect(el.querySelector(".msg-reactions")).toBeNull();
    await edit((m) => ({ ...m, reactions: [{ emoji: "👍", count: 1, me: false }] }));
    expect(row()).toBe(el);
    expect(chipFor("👍")).toBeDefined();
    list.destroy?.();
  });

  it("rebuilds the row when an edit lands with the reaction change", async () => {
    const list = createMessageList(makeListOptions());
    list.mount(container);
    const el = row();
    await edit((m) => ({
      ...m,
      content: "edited",
      editedAt: "2024-01-15T12:01:00Z",
      reactions: [{ emoji: "🎉", count: 2, me: true }],
    }));
    expect(row()).not.toBe(el);
    expect(row().querySelector(".rc-count")?.textContent).toBe("2");
    list.destroy?.();
  });
});
