import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyReadyActiveChannel,
  handleChannelDelete,
  handleMemberUpdate,
  markReadyActiveChannelRead,
} from "./wsHandlers";
import {
  channelsStore,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
} from "../../stores/channels.store";
import { authStore } from "../../stores/auth.store";
import type { Payload } from "../connection/dispatchContext";
import type { ReadyChannel } from "../../lib/types";

vi.mock("../../lib/read-state", () => ({ markChannelRead: vi.fn() }));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
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

beforeEach(() => {
  resetChannelsStore();
  vi.clearAllMocks();
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
