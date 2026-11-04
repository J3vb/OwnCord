/**
 * Rows drawn before the server's custom-emoji set arrives show `:shortcode:`
 * as text. When the set lands (or an emoji is added), the list redraws them
 * with the image. A list with no shortcode anywhere is left alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchImageAsObjectUrlMock } = vi.hoisted(() => ({
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));
vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

import { createMessageList } from "@components/MessageList";
import type { Message } from "@stores/messages.store";
import { emojiStore, setCustomEmoji, clearCustomEmoji } from "@stores/emoji.store";
import { makeMessage, makeOpts, resetGateStores } from "../helpers/message-actions-fixtures";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";
import { resetChannelsState } from "../helpers/storeSeeds";
import { setMessagesFlushed } from "../helpers/messageListHarness";

const CHANNEL_ID = 1;
const ALICE = { id: 2, username: "alice", avatar: null };

function msg(id: number, content: string, extra: Partial<Message> = {}): Message {
  return makeMessage({
    id,
    user: ALICE,
    content,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, 0) + id * 600_000).toISOString(),
    ...extra,
  });
}

function loadEmoji(): void {
  setCustomEmoji([{ id: 7, shortcode: "wave", url: "/api/v1/emoji/7/image" }]);
  emojiStore.flush();
}

describe("MessageList: custom emoji that arrive after the rows", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;

  const mount = (): void => {
    list = createMessageList(makeOpts({ currentUserId: 99 }));
    list.mount(container);
  };
  const emojiImages = (): HTMLImageElement[] => [
    ...container.querySelectorAll<HTMLImageElement>(".msg-text img.custom-emoji"),
  ];

  beforeEach(() => {
    resetGateStores();
    resetMessagesState();
    resetMembersState();
    resetChannelsState();
    clearCustomEmoji();
    emojiStore.flush();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    clearCustomEmoji();
    emojiStore.flush();
  });

  it("redraws a row named :wave: with the image once the emoji set loads", () => {
    setMessagesFlushed(CHANNEL_ID, [msg(1, "hi :wave:")]);
    mount();
    expect(emojiImages()).toHaveLength(0);
    expect(container.textContent).toContain(":wave:");

    loadEmoji();

    const imgs = emojiImages();
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.dataset["shortcode"]).toBe("wave");
  });

  it("redraws a custom-emoji reaction pill once the emoji set loads", () => {
    setMessagesFlushed(CHANNEL_ID, [
      msg(1, "plain text", { reactions: [{ emoji: ":wave:", count: 1, me: false }] }),
    ]);
    mount();
    expect(container.querySelectorAll(".reaction-chip img.custom-emoji")).toHaveLength(0);

    loadEmoji();

    expect(container.querySelectorAll(".reaction-chip img.custom-emoji")).toHaveLength(1);
  });

  it("keeps the rows when no loaded message names a shortcode", () => {
    setMessagesFlushed(CHANNEL_ID, [msg(1, "no emoji here"), msg(2, "time 10:30 sharp")]);
    mount();
    const before = container.querySelector("[data-testid='message-1']");
    expect(before).not.toBeNull();

    loadEmoji();

    expect(container.querySelector("[data-testid='message-1']")).toBe(before);
  });
});
