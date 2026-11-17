import { describe, it, expect, beforeEach } from "vitest";
import { noteDmMessage } from "../../src/features/messaging/chatNotify";
import { blocksStore } from "../../src/stores/blocks.store";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";
import type { Payload } from "../../src/features/connection/dispatchContext";

const DM = 100;

function groupDm(): DmChannel {
  return {
    channelId: DM,
    recipient: { id: 1, username: "alice", avatar: "", status: "online" },
    participants: [{ id: 1, username: "alice", avatar: "", status: "online" }],
    name: "group",
    isGroup: true,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

function message(userId: number, content: string, id: number): Payload<"chat_message"> {
  return {
    id,
    channel_id: DM,
    content,
    timestamp: "2026-01-01T00:00:00Z",
    user: { id: userId, username: `u${userId}`, avatar: "" },
  } as Payload<"chat_message">;
}

const lastMessage = (): string => dmStore.getState().channels[0]?.lastMessage ?? "";

describe("noteDmMessage preview", () => {
  beforeEach(() => {
    dmStore.setState(() => ({ channels: [groupDm()] }));
    blocksStore.setState((prev) => ({ ...prev, blockedByMe: new Set([7]) }));
  });

  it("shows the blocked-message text for a blocked author", () => {
    noteDmMessage(message(7, "secret words", 1), null, false, false, false);
    expect(lastMessage()).toBe("Blocked message");
  });

  it("shows the blocked-message text while that DM is open", () => {
    noteDmMessage(message(7, "secret words", 2), DM, false, false, false);
    expect(lastMessage()).toBe("Blocked message");
  });

  it("shows the content of an author who is not blocked", () => {
    noteDmMessage(message(8, "hello", 3), null, false, false, false);
    expect(lastMessage()).toBe("hello");
  });
});
