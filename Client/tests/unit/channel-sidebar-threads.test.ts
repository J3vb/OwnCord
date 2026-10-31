/**
 * Followed threads in the channel sidebar (WP 6.9c-c2): rows under the parent,
 * the cap and the "N more" row, visibility with the parent, and the menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    rePinPeerIdentity: vi.fn(async () => true),
  }),
);
vi.mock("@lib/ui/toast", () => ({
  showToast: vi.fn(),
  initToast: vi.fn(),
  teardownToast: vi.fn(),
}));

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import {
  channelsStore,
  removeChannel,
  resetChannelsStore,
  setChannels,
} from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import {
  adoptReadyThreads,
  applyFollowUpdate,
  resetThreadsStore,
} from "../../src/stores/threads.store";
import { followedThreadsStore } from "../../src/stores/followedThreads.store";
import { muteChannel, unmuteChannel } from "../../src/lib/prefs/channelMutes";
import { setHideMutedChannels } from "../../src/lib/prefs/hideMutedChannels";
import type { ReadyChannel, ReadyThread } from "../../src/lib/types";
import { makeThread } from "../helpers/thread-fixtures";

const text = (id: number, over: Partial<ReadyChannel> = {}): ReadyChannel => ({
  id,
  name: `chan-${id}`,
  type: "text",
  category: "Text Channels",
  position: id,
  ...over,
});

function followedThread(id: number, parent: number, over: Partial<ReadyThread> = {}): ReadyThread {
  return {
    thread: makeThread({
      id,
      parent_id: parent,
      name: `thread-${id}`,
      last_message_at: `2026-10-${String(10 + (id % 20)).padStart(2, "0")}T00:00:00Z`,
    }),
    last_message_id: 10,
    last_read_message_id: 10,
    unread_count: 0,
    mention_count: 0,
    ...over,
  };
}

function flushAll(): void {
  followedThreadsStore.flush();
  channelsStore.flush();
  uiStore.flush();
}

const rowKeys = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".category-channels-container > *")).map(
    (el) =>
      el.dataset.threadId !== undefined
        ? `t${el.dataset.threadId}`
        : el.dataset.moreParentId !== undefined
          ? `m${el.dataset.moreParentId}`
          : (el.dataset.channelId ?? "?"),
  );

describe("followed threads in the sidebar", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  const onOpenThread = vi.fn();
  const onOpenThreadList = vi.fn();
  const onUnfollowThread = vi.fn();
  const onMarkThreadRead = vi.fn();

  beforeEach(() => {
    resetChannelsStore();
    resetThreadsStore();
    authStore.setState(() => ({
      token: "t",
      user: { id: 1, username: "me", avatar: null, role: "member" },
      serverName: "S",
      motd: null,
      isAuthenticated: true,
    }));
    uiStore.setState((prev) => ({
      ...prev,
      connectionStatus: "connected" as const,
      collapsedCategories: new Set<string>(),
    }));
    unmuteChannel(1);
    setHideMutedChannels(false);
    onOpenThread.mockClear();
    onOpenThreadList.mockClear();
    onUnfollowThread.mockClear();
    onMarkThreadRead.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onOpenThread,
      onOpenThreadList,
      onUnfollowThread,
      onMarkThreadRead,
    });
  });
  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    unmuteChannel(1);
    setHideMutedChannels(false);
    resetThreadsStore();
  });

  it("draws a followed thread under its parent, indented, with the thread icon", () => {
    setChannels([text(1), text(2)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    expect(rowKeys(container)).toEqual(["1", "t91", "2"]);
    const row = container.querySelector<HTMLElement>('[data-thread-id="91"]')!;
    expect(row.classList.contains("thread-item")).toBe(true);
    expect(row.querySelector(".ch-name")?.textContent).toBe("thread-91");
    expect(row.querySelector(".ch-icon svg")).not.toBeNull();
    expect(row.hasAttribute("data-drag-channel-id")).toBe(false);
    expect(row.classList.contains("channel-draggable")).toBe(false);
  });

  it("bolds an unread thread and shows its mention badge", () => {
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1, { unread_count: 2, mention_count: 3 })]);
    sidebar.mount(container);
    const row = container.querySelector<HTMLElement>('[data-thread-id="91"]')!;
    expect(row.classList.contains("unread")).toBe(true);
    expect(row.querySelector(".mention-badge")?.textContent).toBe("3");
  });

  it("orders a parent's threads by activity, newest first", () => {
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1), followedThread(95, 1), followedThread(93, 1)]);
    sidebar.mount(container);
    expect(rowKeys(container)).toEqual(["1", "t95", "t93", "t91"]);
  });

  it("shows five threads and an N more row that opens the Threads list", () => {
    setChannels([text(1)]);
    adoptReadyThreads([91, 92, 93, 94, 95, 96, 97].map((id) => followedThread(id, 1)));
    sidebar.mount(container);
    const keys = rowKeys(container);
    expect(keys).toHaveLength(1 + 5 + 1);
    expect(keys.at(-1)).toBe("m1");
    const more = container.querySelector<HTMLElement>('[data-more-parent-id="1"]')!;
    expect(more.textContent).toContain("2 more");
    more.click();
    expect(onOpenThreadList).toHaveBeenCalledWith(1);
  });

  it("opens the parent and the panel on a click", () => {
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    container.querySelector<HTMLElement>('[data-thread-id="91"]')!.click();
    expect(onOpenThread).toHaveBeenCalledWith(91, 1);
  });

  it("follows live updates: a new follow adds a row and an unfollow removes it", () => {
    setChannels([text(1)]);
    sidebar.mount(container);
    expect(rowKeys(container)).toEqual(["1"]);
    applyFollowUpdate(91, true, makeThread({ id: 91, parent_id: 1 }));
    flushAll();
    expect(rowKeys(container)).toEqual(["1", "t91"]);
    applyFollowUpdate(91, false);
    flushAll();
    expect(rowKeys(container)).toEqual(["1"]);
  });

  it("hides the rows with a collapsed category", () => {
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    expect(rowKeys(container)).toContain("t91");
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(["Text Channels"]) }));
    flushAll();
    expect(rowKeys(container)).not.toContain("t91");
  });

  it("hides the rows when the parent is muted and muted channels are hidden", () => {
    setChannels([text(1), text(2)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    setHideMutedChannels(true);
    muteChannel(1);
    flushAll();
    expect(rowKeys(container)).toEqual(["2"]);
    unmuteChannel(1);
    flushAll();
    expect(rowKeys(container)).toEqual(["1", "t91", "2"]);
  });

  it("drops the rows when the parent becomes unreadable, and ready brings them back", () => {
    setChannels([text(1), text(2)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    removeChannel(1);
    flushAll();
    expect(rowKeys(container)).toEqual(["2"]);
    // The next ready lists the parent again and the thread with it.
    setChannels([text(1), text(2)]);
    adoptReadyThreads([followedThread(91, 1)]);
    flushAll();
    expect(rowKeys(container)).toEqual(["1", "t91", "2"]);
  });

  it("removes the row when another device unfollows, and ignores a late follow for a deleted thread", async () => {
    const { removeThread } = await import("../../src/stores/threads.store");
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    applyFollowUpdate(91, false);
    flushAll();
    expect(rowKeys(container)).toEqual(["1"]);
    removeThread(91);
    applyFollowUpdate(91, true, makeThread({ id: 91, parent_id: 1 }));
    flushAll();
    expect(rowKeys(container)).toEqual(["1"]);
  });

  it("offers Mark as Read and Unfollow on the row menu", () => {
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1, { unread_count: 1 })]);
    sidebar.mount(container);
    const row = container.querySelector<HTMLElement>('[data-thread-id="91"]')!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    (document.querySelector('[data-testid="ctx-thread-mark-read"]') as HTMLElement).click();
    expect(onMarkThreadRead).toHaveBeenCalledWith(91);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    (document.querySelector('[data-testid="ctx-thread-unfollow"]') as HTMLElement).click();
    expect(onUnfollowThread).toHaveBeenCalledWith(91);
  });

  it("disables Mark as Read for a thread with nothing unread", () => {
    setChannels([text(1)]);
    adoptReadyThreads([followedThread(91, 1)]);
    sidebar.mount(container);
    container
      .querySelector<HTMLElement>('[data-thread-id="91"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    const item = document.querySelector('[data-testid="ctx-thread-mark-read"]') as HTMLElement;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    item.click();
    expect(onMarkThreadRead).not.toHaveBeenCalled();
  });
});
