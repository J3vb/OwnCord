import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyReadyActiveChannel,
  handleChannelDelete,
  handleMemberUpdate,
  handleMentionCount,
  markReadyActiveChannelRead,
} from "./wsHandlers";
import {
  channelsStore,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
} from "../../stores/channels.store";
import { messagesStore } from "../../stores/messages.store";
import { dmStore } from "../../stores/dm.store";
import { authStore } from "../../stores/auth.store";
import type { Payload } from "../connection/dispatchContext";
import type { ReadyChannel } from "../../lib/types";

vi.mock("../../lib/read-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/read-state")>();
  return { ...actual, markChannelRead: vi.fn() };
});
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
let lastChannel: number | null = null;
vi.mock("../../lib/last-channel", () => ({
  loadLastChannel: () => lastChannel,
  rememberLastChannel: vi.fn(),
  setLastChannelHost: vi.fn(),
}));
import { markChannelRead } from "../../lib/read-state";
import { showToast } from "../../lib/toast";

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
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  hasFocus.mockRestore();
});

describe("applyReadyActiveChannel", () => {
  it("auto-selects the first text channel when none is active, and marks nothing read", () => {
    const seen = applyReadyActiveChannel(ready([channel(1, "voice", 0), channel(2, "text", 1)]));

    expect(channelsStore.getState().activeChannelId).toBe(2);
    expect(seen).toBeNull();
  });

  it("clears an active channel the snapshot no longer has, and marks nothing read", () => {
    setChannels([channel(3, "text", 0)]);
    setActiveChannel(3);

    const seen = applyReadyActiveChannel(ready([channel(4, "text", 0)]));

    expect(channelsStore.getState().activeChannelId).toBeNull();
    expect(seen).toBeNull();
  });

  it("restores the server's last channel instead of the first text channel (UX-8)", () => {
    lastChannel = 5;

    const seen = applyReadyActiveChannel(
      ready([channel(1, "text", 0), channel(5, "text", 1), channel(9, "text", 2)]),
    );

    expect(channelsStore.getState().activeChannelId).toBe(5);
    expect(seen).toBeNull();
  });

  it("falls back to the first text channel when the remembered one is gone (UX-8)", () => {
    lastChannel = 999;

    applyReadyActiveChannel(ready([channel(1, "text", 0), channel(2, "text", 1)]));

    expect(channelsStore.getState().activeChannelId).toBe(1);
  });

  it("keeps channel 1's unread badge when the restored last channel is 5 (UX-8)", () => {
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
});

describe("handleChannelDelete", () => {
  it("redirects a deleted active channel to the lowest-positioned text channel", () => {
    setChannels([channel(1, "text", 0), channel(2, "text", 5), channel(3, "text", 2)]);
    setActiveChannel(1);

    handleChannelDelete({ id: 1 });

    expect(channelsStore.getState().activeChannelId).toBe(3);
    expect(showToast).toHaveBeenCalledWith("This channel was deleted", "info");
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

  it("applies a frame for the active channel while the window is unfocused", () => {
    hasFocus.mockReturnValue(false);
    setChannels([{ ...channel(2, "text", 0), mention_count: 0 }]);
    setActiveChannel(2);

    handleMentionCount({ channel_id: 2, count: 3 });

    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(3);
  });

  it("applies a frame for a detached active channel even while focused", () => {
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([2]) }));
    setChannels([{ ...channel(2, "text", 0), mention_count: 0 }]);
    setActiveChannel(2);

    handleMentionCount({ channel_id: 2, count: 3 });

    expect(channelsStore.getState().channels.get(2)?.mentionCount).toBe(3);
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
