import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dmStore } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { watchGroupDmExits } from "./groupExitWatch";

function dm(channelId: number, isGroup: boolean): DmChannel {
  return {
    channelId,
    recipient: { id: 10, username: "alice", avatar: "", status: "online" },
    participants: [],
    name: "",
    isGroup,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

let stop: (() => void) | null = null;

beforeEach(() => {
  dmStore.setState(() => ({ channels: [] }));
});

afterEach(() => {
  stop?.();
  stop = null;
  dmStore.setState(() => ({ channels: [] }));
});

describe("watchGroupDmExits", () => {
  it("reports a group that was present and is now gone", () => {
    dmStore.setState(() => ({ channels: [dm(5, true), dm(6, true)] }));
    const onExit = vi.fn();
    stop = watchGroupDmExits(onExit);
    dmStore.setState(() => ({ channels: [dm(6, true)] }));
    dmStore.flush();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("does not report a 1:1 closing", () => {
    dmStore.setState(() => ({ channels: [dm(5, false)] }));
    const onExit = vi.fn();
    stop = watchGroupDmExits(onExit);
    dmStore.setState(() => ({ channels: [] }));
    dmStore.flush();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("does not report a channel that was never listed", () => {
    const onExit = vi.fn();
    stop = watchGroupDmExits(onExit);
    dmStore.setState(() => ({ channels: [dm(7, true)] }));
    dmStore.flush();
    dmStore.setState(() => ({ channels: [dm(7, true), dm(8, false)] }));
    dmStore.flush();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("reports a group added after the watch started once it goes", () => {
    const onExit = vi.fn();
    stop = watchGroupDmExits(onExit);
    dmStore.setState(() => ({ channels: [dm(9, true)] }));
    dmStore.flush();
    dmStore.setState(() => ({ channels: [] }));
    dmStore.flush();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it("stops reporting after unsubscribe", () => {
    dmStore.setState(() => ({ channels: [dm(5, true)] }));
    const onExit = vi.fn();
    watchGroupDmExits(onExit)();
    dmStore.setState(() => ({ channels: [] }));
    dmStore.flush();
    expect(onExit).not.toHaveBeenCalled();
  });
});
