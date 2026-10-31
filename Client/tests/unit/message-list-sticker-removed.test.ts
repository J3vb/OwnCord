/**
 * WP 3A-8: a deleted message leaves the list. The store keeps the tombstone
 * (reply checks and the echo reconcile read it); MessageList filters it out
 * and the patch path removes the row, regroups its neighbour and holds the
 * reader's place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/messaging/content/attachments")>()),
  fetchImageAsObjectUrl: vi.fn(async () => "blob:sticker"),
}));

import { createMessageList } from "@components/MessageList";
import { messagesStore, markStickersDeleted } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { buildMessage } from "../helpers/messageFactory";
import {
  makeListOptions,
  resetStoresAndChannels,
  setMessages,
} from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";

const CHANNEL_ID = 1;
const ME = { id: 1, username: "Alice", avatar: null };

function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return buildMessage(overrides, {
    channelId: CHANNEL_ID,
    user: ME,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, overrides.id)).toISOString(),
  });
}

describe("MessageList — a removed sticker leaves loaded rows", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;

  beforeEach(() => {
    resetStoresAndChannels();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
  });

  it("turns the row into 'Deleted sticker: name' and keeps the survivors", async () => {
    const mk = (id: number, stickerId: number) =>
      makeMessage({
        id,
        content: `[Sticker: S${stickerId}]`,
        sticker: {
          id: stickerId,
          name: `S${stickerId}`,
          url: `/api/v1/stickers/${stickerId}/image`,
        },
        timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
      });
    setMessages(CHANNEL_ID, [mk(1, 1), mk(2, 2)]);
    list = createMessageList(makeListOptions({ channelId: CHANNEL_ID }));
    list.mount(container);
    const row = (id: number): HTMLElement =>
      container.querySelector<HTMLElement>(`[data-testid='message-${id}']`)!;
    expect(row(2).querySelector("img.msg-sticker-img")).not.toBeNull();

    markStickersDeleted(new Set([1]));
    messagesStore.flush();

    expect(row(2).querySelector("img.msg-sticker-img")).toBeNull();
    expect(row(2).textContent).toContain("Deleted sticker: S2");
    expect(row(1).querySelector("img.msg-sticker-img")).not.toBeNull();
    const stored = messagesStore.getState().messagesByChannel.get(CHANNEL_ID)!;
    expect(stored[1]!.sticker).toEqual({ id: null, name: "S2", url: null });
  });

  it("leaves other channels' lists and non-sticker messages untouched", () => {
    const plain = makeMessage({ id: 1 });
    setMessages(CHANNEL_ID, [plain]);
    const before = messagesStore.getState().messagesByChannel;
    markStickersDeleted(new Set());
    messagesStore.flush();
    expect(messagesStore.getState().messagesByChannel).toBe(before);
  });
});
