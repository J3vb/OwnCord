import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStore, type Channel } from "../../stores/channels.store";
import { dmStore, type DmChannel } from "../../stores/dm.store";
import {
  invalidateMuteCache,
  muteChannel,
  setChannelMutesHost,
} from "../../lib/prefs/channelMutes";
import { savePref } from "../../lib/prefs/preferences";
import {
  setChannelNotificationLevel,
  setGlobalNotificationLevel,
} from "../../lib/prefs/notificationLevel";
import { startUnreadBadge, unreadBadgeCount } from "./unreadBadge";
import { followedThreadsStore } from "../../stores/followedThreads.store";
import { adoptReadyThreads, resetThreadsStore } from "../../stores/threads.store";
import type { ReadyThread } from "../../lib/types";

function channel(id: number, patch: Partial<Channel>): Channel {
  return {
    id,
    name: `ch${id}`,
    type: "text",
    category: null,
    topic: "",
    position: id,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...patch,
  };
}

function dm(channelId: number, unreadCount: number, mentionCount = 0): DmChannel {
  const user = { id: channelId + 1000, username: `u${channelId}`, avatar: "", status: "online" };
  return {
    channelId,
    recipient: user,
    participants: [user],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount,
    mentionCount,
  };
}

function setChannelList(list: readonly Channel[]): void {
  channelsStore.setState((prev) => ({ ...prev, channels: new Map(list.map((c) => [c.id, c])) }));
  channelsStore.flush();
}

function followedFlush(): void {
  followedThreadsStore.flush();
}

function setDms(list: readonly DmChannel[]): void {
  dmStore.setState(() => ({ channels: list }));
  dmStore.flush();
}

const followedThread = (id: number, parent: number, mentions: number): ReadyThread => ({
  thread: {
    id,
    parent_id: parent,
    name: `t${id}`,
    owner_id: 1,
    starter_message_id: id,
    archived: false,
    locked: false,
    auto_archive_minutes: 1440,
    message_count: 1,
    last_message_at: null,
    created_at: "2026-10-20T00:00:00Z",
  },
  last_message_id: 9,
  last_read_message_id: 1,
  unread_count: mentions,
  mention_count: mentions,
});

describe("unread badge", () => {
  beforeEach(() => {
    localStorage.clear();
    setChannelMutesHost("badge.test");
    invalidateMuteCache();
    setGlobalNotificationLevel("mentions");
    setChannelList([]);
    setDms([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setChannelList([]);
    setDms([]);
    localStorage.clear();
    invalidateMuteCache();
  });

  it("the badge count is channel mentions plus DM unread, muted channels add no plain unread but their mentions still count, and it is pushed once per change (deduplicated)", () => {
    const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
    const stop = startUnreadBadge({ setUnreadBadge });

    setChannelList([
      // Plain unread in a guild channel is chatter, not a badge.
      channel(1, { unreadCount: 7, mentionCount: 2 }),
      channel(2, { unreadCount: 4 }),
      // A DM's mirror row in the channels store must not count twice.
      channel(10, { type: "dm", unreadCount: 3, mentionCount: 1 }),
    ]);
    setDms([dm(10, 3, 1), dm(11, 1)]);
    expect(unreadBadgeCount()).toBe(2 + 3 + 1);

    // Muted: a DM's plain unread drops out, but its mention still counts.
    muteChannel(10);
    expect(unreadBadgeCount()).toBe(2 + 1 + 1);

    // A new plain message in a guild channel leaves the count unchanged.
    setChannelList([
      channel(1, { unreadCount: 8, mentionCount: 2 }),
      channel(2, { unreadCount: 5 }),
      channel(10, { type: "dm", unreadCount: 3, mentionCount: 1 }),
    ]);

    // One push per distinct count (empty, channels, DMs, mute); none for the chatter.
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([0, 2, 6, 4]);
    stop();
  });

  it("re-pushes the unchanged count when the window is focused or shown, but not on a store change that leaves it unchanged", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
    setDms([dm(20, 3)]);
    const stop = startUnreadBadge({ setUnreadBadge });

    setChannelList([channel(1, { unreadCount: 4 })]);
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([3]);

    window.dispatchEvent(new Event("focus"));
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([3, 3]);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([3, 3, 3]);

    setChannelList([channel(1, { unreadCount: 5 })]);
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([3, 3, 3]);

    stop();
    window.dispatchEvent(new Event("focus"));
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([3, 3, 3, 0]);
  });

  it("with the Unread message badge pref off it pushes 0 and stays 0 as the count changes, and turning it on pushes the current count", () => {
    const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
    setDms([dm(30, 4)]);
    savePref("unreadBadge", false);
    const stop = startUnreadBadge({ setUnreadBadge });
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([0]);

    setDms([dm(30, 9)]);
    setChannelList([channel(1, { mentionCount: 2 })]);
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([0]);

    savePref("unreadBadge", true);
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([0, 11]);

    savePref("unreadBadge", false);
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([0, 11, 0]);
    stop();
  });

  it("a wrong-typed stored Unread message badge value behaves as on", () => {
    const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
    setDms([dm(31, 5)]);
    localStorage.setItem("owncord:settings:unreadBadge", JSON.stringify("off"));
    const stop = startUnreadBadge({ setUnreadBadge });
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([5]);
    stop();
  });

  it("a mention in a muted channel counts; plain unread in a muted channel does not", () => {
    setChannelList([
      channel(1, { unreadCount: 9, mentionCount: 1 }),
      channel(2, { unreadCount: 6 }),
    ]);
    setDms([dm(20, 5)]);
    muteChannel(1);
    muteChannel(2);
    muteChannel(20);
    expect(unreadBadgeCount()).toBe(1);
  });

  it("at the 'nothing' level, drops server channels but still counts DMs", () => {
    setChannelList([
      channel(1, { mentionCount: 3 }),
      channel(20, { type: "dm", unreadCount: 5, mentionCount: 1 }),
    ]);
    setDms([dm(20, 5, 1)]);
    setGlobalNotificationLevel("nothing");
    expect(unreadBadgeCount()).toBe(5);
    setGlobalNotificationLevel("mentions");
    expect(unreadBadgeCount()).toBe(3 + 5);
  });

  it("a channel at Nothing drops its mentions; others still count", () => {
    setChannelList([channel(1, { mentionCount: 3 }), channel(2, { mentionCount: 4 })]);
    setChannelNotificationLevel(1, "nothing");
    expect(unreadBadgeCount()).toBe(4);
    setChannelNotificationLevel(1, null);
    expect(unreadBadgeCount()).toBe(7);
  });

  it("an override to All counts under a server at Nothing, and a DM is untouched", () => {
    setChannelList([
      channel(1, { mentionCount: 3 }),
      channel(2, { mentionCount: 4 }),
      channel(20, { type: "dm", unreadCount: 5, mentionCount: 1 }),
    ]);
    setDms([dm(20, 5, 1)]);
    setGlobalNotificationLevel("nothing");
    setChannelNotificationLevel(2, "all");
    expect(unreadBadgeCount()).toBe(4 + 5);
  });

  it("re-pushes the count when a channel's level changes", () => {
    const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
    setChannelList([channel(1, { mentionCount: 3 })]);
    const stop = startUnreadBadge({ setUnreadBadge });
    expect(setUnreadBadge).toHaveBeenLastCalledWith(3);
    setChannelNotificationLevel(1, "nothing");
    expect(setUnreadBadge).toHaveBeenLastCalledWith(0);
    stop();
  });

  it("at the 'nothing' level a muted DM still counts only its mentions", () => {
    setDms([dm(20, 5, 2)]);
    muteChannel(20);
    setGlobalNotificationLevel("nothing");
    expect(unreadBadgeCount()).toBe(2);
  });

  it("clears the badge when it stops, and not again if already clear", () => {
    const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
    setDms([dm(20, 2)]);
    const stop = startUnreadBadge({ setUnreadBadge });
    stop();
    expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([2, 0]);

    const idle = vi.fn((_count: number) => Promise.resolve());
    setDms([]);
    startUnreadBadge({ setUnreadBadge: idle })();
    expect(idle.mock.calls.map((c) => c[0])).toEqual([0]);
  });

  it("swallows a refused push (browser or older host)", async () => {
    const setUnreadBadge = vi.fn((_count: number) => Promise.reject(new Error("unknown command")));
    const stop = startUnreadBadge({ setUnreadBadge });
    setDms([dm(20, 1)]);
    await Promise.resolve();
    expect(setUnreadBadge).toHaveBeenCalledTimes(2);
    stop();
  });

  describe("followed threads", () => {
    afterEach(() => resetThreadsStore());

    it("counts a followed thread's mentions with the channels' and DMs'", () => {
      setChannelList([channel(1, { mentionCount: 2 })]);
      setDms([dm(11, 1)]);
      adoptReadyThreads([followedThread(91, 1, 3)]);
      expect(unreadBadgeCount()).toBe(2 + 1 + 3);
    });

    it("pushes the new count when a thread mention arrives", () => {
      const setUnreadBadge = vi.fn((_count: number) => Promise.resolve());
      setChannelList([channel(1, {})]);
      const stop = startUnreadBadge({ setUnreadBadge });
      adoptReadyThreads([followedThread(91, 1, 2)]);
      followedFlush();
      expect(setUnreadBadge.mock.calls.map((c) => c[0])).toEqual([0, 2]);
      stop();
    });

    it("drops them when the parent's level is Nothing, and when the parent is not listed", () => {
      setChannelList([channel(1, {}), channel(2, {})]);
      adoptReadyThreads([
        followedThread(91, 1, 3),
        followedThread(92, 2, 4),
        followedThread(93, 9, 5),
      ]);
      expect(unreadBadgeCount()).toBe(3 + 4);
      setChannelNotificationLevel(1, "nothing");
      expect(unreadBadgeCount()).toBe(4);
    });
  });
});
