import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStore, type Channel } from "../../stores/channels.store";
import { dmStore, type DmChannel } from "../../stores/dm.store";
import { invalidateMuteCache, muteChannel, setChannelMutesHost } from "../../lib/channel-mutes";
import { setGlobalNotificationLevel } from "../../lib/notificationLevel";
import { startUnreadBadge, unreadBadgeCount } from "./unreadBadge";

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

function setDms(list: readonly DmChannel[]): void {
  dmStore.setState(() => ({ channels: list }));
  dmStore.flush();
}

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

  it("counts nothing at the 'nothing' notification level", () => {
    setChannelList([channel(1, { mentionCount: 3 })]);
    setDms([dm(20, 5)]);
    setGlobalNotificationLevel("nothing");
    expect(unreadBadgeCount()).toBe(0);
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
});
