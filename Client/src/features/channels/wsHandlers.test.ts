import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyReadyActiveChannel,
  applyReadyChannels,
  handleChannelCategories,
  handleChannelDelete,
  handleMemberBan,
  handleMemberUpdate,
  handleChannelActivity,
  handleMentionCount,
  markReadyActiveChannelRead,
  MENTION_ALERT_GRACE_MS,
  resetChannelActivity,
} from "./wsHandlers";
import {
  channelsStore,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
  setMentionCount,
} from "../../stores/channels.store";
import { messagesStore } from "../../stores/messages.store";
import { dmStore } from "../../stores/dm.store";
import { authStore } from "../../stores/auth.store";
import { setLiveTailInView } from "../../lib/readState";
import type { Payload } from "../connection/dispatchContext";
import type { ReadyChannel } from "../../lib/types";
import type { Message } from "../../stores/messages.store";

vi.mock("../../lib/readState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/readState")>();
  return { ...actual, markChannelRead: vi.fn() };
});
vi.mock("../../lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../lib/notifications", () => ({
  notifyMention: vi.fn(),
  notifyChannelActivity: vi.fn(),
}));
let lastChannel: number | null = null;
vi.mock("../../lib/prefs/lastChannel", () => ({
  loadLastChannel: () => lastChannel,
  rememberLastChannel: vi.fn(),
  setLastChannelHost: vi.fn(),
}));
import { markChannelRead } from "../../lib/readState";
import { showToast } from "../../lib/ui/toast";
import { notifyChannelActivity, notifyMention } from "../../lib/notifications";

vi.spyOn(console, "info").mockImplementation(() => {});

function channel(id: number, type: ReadyChannel["type"], position: number): ReadyChannel {
  return { id, name: `c${id}`, type, category: null, position };
}

function ready(channels: ReadyChannel[], dmIds: number[] = []): Payload<"ready"> {
  return {
    channels,
    dm_channels: dmIds.map((channel_id) => ({ channel_id })),
  } as unknown as Payload<"ready">;
}

let hasFocus: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetChannelsStore();
  messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set() }));
  lastChannel = null;
  vi.clearAllMocks();
  resetChannelActivity();
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  resetChannelActivity();
  vi.useRealTimers();
  hasFocus.mockRestore();
});

describe("channel categories", () => {
  beforeEach(() => resetChannelsStore());

  it("ready carries the managers' list into the store, and its absence empties it", () => {
    const withList = {
      channels: [],
      members: [],
      roles: [],
      categories: [
        { id: 2, name: "B", position: 1 },
        { id: 1, name: "A", position: 0 },
      ],
    } as unknown as Payload<"ready">;
    applyReadyChannels(withList);
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([1, 2]);

    // A non-manager's (or an older server's) ready has no key at all.
    applyReadyChannels({ channels: [], members: [], roles: [] } as unknown as Payload<"ready">);
    expect(channelsStore.getState().categories).toEqual([]);
  });

  it("channel_categories replaces the list wholesale", () => {
    handleChannelCategories({ categories: [{ id: 1, name: "A", position: 0 }] });
    handleChannelCategories({ categories: [{ id: 5, name: "E", position: 0 }] });
    expect(channelsStore.getState().categories).toEqual([{ id: 5, name: "E", position: 0 }]);
  });
});

describe("applyReadyActiveChannel", () => {
  it("auto-selects the first text channel when none is active, and marks nothing read", () => {
    const seen = applyReadyActiveChannel(ready([channel(1, "voice", 0), channel(2, "text", 1)]));

    expect(channelsStore.getState().activeChannelId).toBe(2);
    expect(seen).toBeNull();
  });

  it("auto-selects the first text channel in sidebar order, not payload order (6.5)", () => {
    const inCategory = (id: number, catId: number, catPos: number, pos: number): ReadyChannel => ({
      ...channel(id, "text", pos),
      category_id: catId,
      category_position: catPos,
    });
    // Payload order is by position; the sidebar puts uncategorized rows first,
    // then categories by category position.
    applyReadyActiveChannel(
      ready([inCategory(1, 7, 1, 0), inCategory(2, 8, 0, 1), channel(3, "text", 2)]),
    );
    expect(channelsStore.getState().activeChannelId).toBe(3);

    resetChannelsStore();
    applyReadyActiveChannel(ready([inCategory(1, 7, 1, 0), inCategory(2, 8, 0, 1)]));
    expect(channelsStore.getState().activeChannelId).toBe(2);
  });

  it("clears an active channel the snapshot no longer has, and marks nothing read", () => {
    setChannels([channel(3, "text", 0)]);
    setActiveChannel(3);

    const seen = applyReadyActiveChannel(ready([channel(4, "text", 0)]));

    expect(channelsStore.getState().activeChannelId).toBeNull();
    expect(seen).toBeNull();
  });

  it("restores the server's last channel instead of the first text channel", () => {
    lastChannel = 5;

    const seen = applyReadyActiveChannel(
      ready([channel(1, "text", 0), channel(5, "text", 1), channel(9, "text", 2)]),
    );

    expect(channelsStore.getState().activeChannelId).toBe(5);
    expect(seen).toBeNull();
  });

  it("falls back to the first text channel when the remembered one is gone", () => {
    lastChannel = 999;

    applyReadyActiveChannel(ready([channel(1, "text", 0), channel(2, "text", 1)]));

    expect(channelsStore.getState().activeChannelId).toBe(1);
  });

  it("keeps channel 1's unread badge when the restored last channel is 5", () => {
    lastChannel = 5;
    setChannels([{ ...channel(1, "text", 0), unread_count: 4 }, { ...channel(5, "text", 1) }]);

    applyReadyActiveChannel(ready([{ ...channel(1, "text", 0) }, { ...channel(5, "text", 1) }]));

    expect(channelsStore.getState().activeChannelId).toBe(5);
    // Channel 1 was never mounted/viewed, so its badge survives the launch.
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(4);
  });

  it("keeps an active DM that is still open, and marks it read", () => {
    setChannels([channel(3, "text", 0)]);
    setActiveChannel(3);

    const seen = applyReadyActiveChannel(ready([channel(4, "text", 0)], [3]));

    expect(channelsStore.getState().activeChannelId).toBe(3);
    expect(seen).toBe(3);
  });
});

describe("markReadyActiveChannelRead", () => {
  it("marks the channel the user was reading", () => {
    markReadyActiveChannelRead(5);
    expect(markChannelRead).toHaveBeenCalledWith(5);
  });

  it("marks nothing for a forum, which holds no messages", () => {
    setChannels([channel(5, "forum", 0)]);
    markReadyActiveChannelRead(5);
    expect(markChannelRead).not.toHaveBeenCalled();
  });

  it("marks nothing when there is no channel to mark", () => {
    markReadyActiveChannelRead(null);
    expect(markChannelRead).not.toHaveBeenCalled();
  });

  it("keeps the restated unread count and sends no mark_read on an unfocused ready", () => {
    hasFocus.mockReturnValue(false);
    setChannels([{ ...channel(5, "text", 0), unread_count: 5 }]);
    setActiveChannel(5, { clearUnread: false });

    const seen = applyReadyActiveChannel(ready([channel(5, "text", 0)]));
    markReadyActiveChannelRead(seen);

    expect(markChannelRead).not.toHaveBeenCalled();
    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(5);
  });

  it("does not mark a detached active channel read even while focused", () => {
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([5]) }));

    markReadyActiveChannelRead(5);

    expect(markChannelRead).not.toHaveBeenCalled();
  });

  it("does not mark an active channel read while its list is scrolled up", () => {
    setLiveTailInView(5, false);

    markReadyActiveChannelRead(5);
    setLiveTailInView(5, true);

    expect(markChannelRead).not.toHaveBeenCalled();
  });
});

describe("handleChannelDelete", () => {
  it("redirects a deleted active channel to the lowest-positioned text channel", () => {
    setChannels([channel(1, "text", 0), channel(2, "text", 5), channel(3, "text", 2)]);
    setActiveChannel(1);

    handleChannelDelete({ id: 1 });

    expect(channelsStore.getState().activeChannelId).toBe(3);
    expect(showToast).toHaveBeenCalledWith(
      "You no longer have access to this channel, or it was deleted",
      "info",
    );
  });

  it("leaves the active channel alone when another channel is deleted", () => {
    setChannels([channel(1, "text", 0), channel(2, "text", 1)]);
    setActiveChannel(1);

    handleChannelDelete({ id: 2 });

    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("handleMentionCount", () => {
  describe("notifies for a mention in another channel", () => {
    // The alert waits MENTION_ALERT_GRACE_MS for a channel_activity frame
    // (WP 2B-2); these cases model a server that never sends one.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("notifies once when the total rises on a channel that is not active", () => {
      setChannels([channel(2, "text", 0), channel(3, "text", 1)]);
      setActiveChannel(2);

      handleMentionCount({ channel_id: 3, count: 1 });
      vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

      expect(notifyMention).toHaveBeenCalledTimes(1);
      expect(notifyMention).toHaveBeenCalledWith(3);
    });

    it("does not notify when the total falls (a delete or purge)", () => {
      setChannels([channel(2, "text", 0), channel(3, "text", 1)]);
      setActiveChannel(2);
      setMentionCount(3, 1);

      handleMentionCount({ channel_id: 3, count: 0 });
      vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

      expect(notifyMention).not.toHaveBeenCalled();
    });

    it("does not notify when the total is unchanged", () => {
      setChannels([channel(2, "text", 0), channel(3, "text", 1)]);
      setActiveChannel(2);
      setMentionCount(3, 2);

      handleMentionCount({ channel_id: 3, count: 2 });
      vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

      expect(notifyMention).not.toHaveBeenCalled();
    });

    it("never notifies for the active channel, focused or away", () => {
      setChannels([channel(2, "text", 0)]);
      setActiveChannel(2);

      handleMentionCount({ channel_id: 2, count: 1 });
      hasFocus.mockReturnValue(false);
      handleMentionCount({ channel_id: 2, count: 2 });
      vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

      expect(notifyMention).not.toHaveBeenCalled();
    });

    it("does not notify for a DM channel id", () => {
      setChannels([{ ...channel(7, "dm", 0), mention_count: 0 }]);

      handleMentionCount({ channel_id: 7, count: 3 });
      vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

      expect(notifyMention).not.toHaveBeenCalled();
    });
  });

  it("sets the badge total on a guild channel from the server's frame", () => {
    setChannels([{ ...channel(2, "text", 0), mention_count: 0, unread_count: 4 }]);

    handleMentionCount({ channel_id: 2, count: 3 });

    const ch = channelsStore.getState().channels.get(2);
    expect(ch?.mentionCount).toBe(3);
    // The frame carries no unread information, so unread is untouched.
    expect(ch?.unreadCount).toBe(4);
  });

  it("ignores a frame for the channel on screen, whose chat_message handles it", () => {
    setChannels([{ ...channel(2, "text", 0), mention_count: 0 }]);
    setActiveChannel(2);

    handleMentionCount({ channel_id: 2, count: 3 });

    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(0);
  });

  it("ignores a frame for the active channel while the window is unfocused", () => {
    hasFocus.mockReturnValue(false);
    setChannels([{ ...channel(2, "text", 0), mention_count: 0 }]);
    setActiveChannel(2);

    handleMentionCount({ channel_id: 2, count: 3 });

    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(0);
  });

  it("lowers the active channel's mention badge while the window is unfocused", () => {
    hasFocus.mockReturnValue(false);
    setChannels([channel(2, "text", 0)]);
    setActiveChannel(2);
    // Activating clears the badge; a mention then lands while away or focused.
    setMentionCount(2, 1);

    handleMentionCount({ channel_id: 2, count: 2 });
    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(1);

    handleMentionCount({ channel_id: 2, count: 0 });
    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(0);
  });

  it("leaves the active channel's mention badge alone while focused", () => {
    setChannels([channel(2, "text", 0)]);
    setActiveChannel(2);
    // Activating clears the badge; a mention then lands while away or focused.
    setMentionCount(2, 1);

    handleMentionCount({ channel_id: 2, count: 0 });

    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(1);
  });

  it("ignores a frame for a channel this client does not know", () => {
    const before = channelsStore.getState();
    handleMentionCount({ channel_id: 999, count: 1 });
    expect(channelsStore.getState()).toBe(before);
  });

  it("ignores a DM-channel id, whose badge lives in dmStore", () => {
    setChannels([{ ...channel(7, "dm", 0), mention_count: 0 }]);
    // dmStore's own row must not be disturbed by a channelsStore frame.
    dmStore.setState(() => ({ channels: [] }));

    handleMentionCount({ channel_id: 7, count: 3 });

    expect(channelsStore.getState().channels.get(7)?.mentionCount).toBe(0);
  });
});

describe("handleMemberUpdate", () => {
  it("syncs the signed-in user's own role into authStore", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 9, username: "me", avatar: null, role: "member" },
    }));

    handleMemberUpdate({ user_id: 9, role: "admin" });
    expect(authStore.getState().user?.role).toBe("admin");

    handleMemberUpdate({ user_id: 10, role: "member" });
    expect(authStore.getState().user?.role).toBe("admin");
  });
});

describe("handleMemberBan", () => {
  it("leaves loaded reply snippets intact — a ban is not an erasure", () => {
    const snippet = {
      id: 50,
      user: { id: 9, username: "gone", avatar: null },
      content: "secret",
      deleted: false,
      has_attachments: false,
    };
    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map([
        [
          1,
          [
            {
              id: 10,
              channelId: 1,
              user: { id: 2, username: "b", avatar: null },
              content: "re",
              replyTo: 50,
              referencedMessage: snippet,
              attachments: [],
              reactions: [],
              pinned: false,
              editedAt: null,
              deleted: false,
              timestamp: "2026-03-15T10:00:00Z",
              status: "sent" as const,
              correlationId: null,
              errorCode: null,
            },
          ],
        ],
      ]),
    }));
    handleMemberBan({ user_id: 9 });
    expect(messagesStore.getState().messagesByChannel.get(1)![0]!.referencedMessage).toBe(snippet);
  });
});

function activityEntry(
  channel_id: number,
  message_id: number,
  flags: Partial<{ author_id: number; mentions_you: boolean; mentions_everyone: boolean }> = {},
): Payload<"channel_activity">["channels"][number] {
  return { channel_id, message_id, mentions_you: false, mentions_everyone: false, ...flags };
}

describe("handleChannelActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map() }));
    setChannels([channel(2, "text", 0), channel(3, "text", 1)]);
    setActiveChannel(2);
  });

  it("shows an unread dot on a channel the reader is not viewing, and alerts", () => {
    const e = activityEntry(3, 50, { author_id: 9 });

    handleChannelActivity({ channels: [e] });

    const ch = channelsStore.getState().channels.get(3)!;
    expect(ch.unreadCount).toBe(1);
    expect(ch.lastMessageId).toBe(50);
    expect(notifyChannelActivity).toHaveBeenCalledTimes(1);
    expect(notifyChannelActivity).toHaveBeenCalledWith(e);
  });

  it("never counts the mention flags toward the badge", () => {
    handleChannelActivity({
      channels: [
        activityEntry(3, 50, { mentions_you: true, mentions_everyone: true }),
        activityEntry(3, 51),
      ],
    });

    const ch = channelsStore.getState().channels.get(3)!;
    expect(ch.mentionCount).toBe(0);
    expect(ch.lastMessageId).toBe(51);
    expect(notifyChannelActivity).toHaveBeenCalledTimes(2);
  });

  it("skips the active channel, unknown channels, DM ids and messages already counted", () => {
    setChannels([channel(2, "text", 0), channel(3, "text", 1), channel(7, "dm", 2)]);
    setActiveChannel(2);
    handleChannelActivity({ channels: [activityEntry(3, 50)] });
    vi.mocked(notifyChannelActivity).mockClear();

    handleChannelActivity({
      channels: [
        activityEntry(2, 60),
        activityEntry(99, 61),
        activityEntry(7, 62),
        activityEntry(3, 50),
        activityEntry(3, 49),
      ],
    });

    expect(channelsStore.getState().channels.get(2)!.unreadCount).toBe(0);
    expect(channelsStore.getState().channels.get(3)!.unreadCount).toBe(1);
    expect(channelsStore.getState().channels.get(7)!.unreadCount).toBe(0);
    expect(notifyChannelActivity).not.toHaveBeenCalled();
  });

  it("a mention entry first, then the mention_count rise: one alert", () => {
    handleChannelActivity({ channels: [activityEntry(3, 50, { mentions_you: true })] });

    handleMentionCount({ channel_id: 3, count: 1 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(channelsStore.getState().channels.get(3)!.mentionCount).toBe(1);
    expect(notifyChannelActivity).toHaveBeenCalledTimes(1);
    expect(notifyMention).not.toHaveBeenCalled();
  });

  it("a mention entry inside the grace window replaces the pending mention_count alert", () => {
    handleMentionCount({ channel_id: 3, count: 1 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS - 1);

    handleChannelActivity({ channels: [activityEntry(3, 50, { mentions_you: true })] });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).not.toHaveBeenCalled();
    expect(notifyChannelActivity).toHaveBeenCalledTimes(1);
  });

  it("a mention the frames did not carry still alerts from mention_count", () => {
    // The server keeps only the newest mentions of a busy window, so the frame
    // may name the channel's latest message with neither flag set.
    handleChannelActivity({ channels: [activityEntry(3, 50)] });

    handleMentionCount({ channel_id: 3, count: 1 });
    handleChannelActivity({ channels: [activityEntry(3, 51)] });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).toHaveBeenCalledTimes(1);
    expect(notifyMention).toHaveBeenCalledWith(3);
  });

  it("a mention entry for another channel leaves this channel's alert pending", () => {
    setChannels([channel(2, "text", 0), channel(3, "text", 1), channel(4, "text", 2)]);
    setActiveChannel(2);

    handleMentionCount({ channel_id: 3, count: 1 });
    handleChannelActivity({ channels: [activityEntry(4, 60, { mentions_you: true })] });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).toHaveBeenCalledTimes(1);
    expect(notifyMention).toHaveBeenCalledWith(3);
  });

  it("a mention entry the watermark skips does not cancel the mention_count alert", () => {
    handleChannelActivity({ channels: [activityEntry(3, 105)] });
    handleMentionCount({ channel_id: 3, count: 1 });

    // A later window can carry an older mention than the latest id seen.
    handleChannelActivity({ channels: [activityEntry(3, 103, { mentions_you: true })] });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).toHaveBeenCalledWith(3);
  });

  it("a server without the frame still alerts from mention_count after the grace window", () => {
    handleMentionCount({ channel_id: 3, count: 1 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS - 1);
    expect(notifyMention).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(notifyMention).toHaveBeenCalledTimes(1);
    expect(notifyMention).toHaveBeenCalledWith(3);
  });

  it("skips a message already loaded in the channel's list (one the reader just read)", () => {
    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map([[3, [{ id: 50 }, { id: 0 }] as unknown as Message[]]]),
    }));

    handleChannelActivity({ channels: [activityEntry(3, 50)] });
    expect(channelsStore.getState().channels.get(3)!.unreadCount).toBe(0);
    expect(notifyChannelActivity).not.toHaveBeenCalled();

    handleChannelActivity({ channels: [activityEntry(3, 51)] });
    expect(channelsStore.getState().channels.get(3)!.unreadCount).toBe(1);
  });

  it("a second mention right after an announced one still alerts when its entry never comes", () => {
    handleChannelActivity({ channels: [activityEntry(3, 50, { mentions_you: true })] });
    handleMentionCount({ channel_id: 3, count: 1 });

    handleMentionCount({ channel_id: 3, count: 2 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyChannelActivity).toHaveBeenCalledTimes(1);
    expect(notifyMention).toHaveBeenCalledTimes(1);
    expect(notifyMention).toHaveBeenCalledWith(3);
  });

  it("a lowered total inside the grace window takes back the pending alert", () => {
    handleMentionCount({ channel_id: 3, count: 1 });
    handleMentionCount({ channel_id: 3, count: 0 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).not.toHaveBeenCalled();
  });

  it("a lowered total takes back only the rises it reverses", () => {
    handleMentionCount({ channel_id: 3, count: 1 });
    handleMentionCount({ channel_id: 3, count: 2 });
    handleMentionCount({ channel_id: 3, count: 1 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).toHaveBeenCalledTimes(1);
  });

  it("a mention entry whose rise never comes stops matching after the grace window", () => {
    handleChannelActivity({ channels: [activityEntry(3, 50, { mentions_you: true })] });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    handleMentionCount({ channel_id: 3, count: 1 });
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).toHaveBeenCalledWith(3);
  });

  it("teardown drops a pending alert", () => {
    handleMentionCount({ channel_id: 3, count: 1 });

    resetChannelActivity();
    vi.advanceTimersByTime(MENTION_ALERT_GRACE_MS);

    expect(notifyMention).not.toHaveBeenCalled();
  });
});
