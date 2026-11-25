import { describe, it, expect, beforeEach } from "vitest";
import { noteDmMessage } from "../../src/features/messaging/chatNotify";
import { handleChatEdited } from "../../src/features/messaging/wsHandlers";
import { blocksStore } from "../../src/stores/blocks.store";
import { addMessage, resetMessagesStore } from "../../src/stores/messages.store";
import {
  dmChannelFromPayload,
  dmStore,
  hideBlockedDmPreviews,
  setDmPreviewFilter,
  type DmChannel,
} from "../../src/stores/dm.store";
import { blockedPreviewText } from "../../src/features/direct-messages/blockedPreviewText";
import type { Payload } from "../../src/features/connection/dispatchContext";
import type { DmChannelPayload } from "../../src/lib/types";

// The DM ws handlers register this when the dispatcher loads them.
setDmPreviewFilter(blockedPreviewText);

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

describe("DM list preview from edits and server summaries", () => {
  const block = (ids: readonly number[]): void =>
    blocksStore.setState((prev) => ({ ...prev, blockedByMe: new Set(ids) }));
  const shown = (id: number, text: string): void =>
    dmStore.setState(() => ({
      channels: [{ ...groupDm(), lastMessageId: id, lastMessage: text }],
    }));
  const summary = (lastId: number, text: string): DmChannelPayload => ({
    channel_id: DM,
    recipient: { id: 1, username: "alice", avatar: "", status: "online" },
    recipients: [
      { id: 1, username: "alice", avatar: "", status: "online" },
      { id: 7, username: "u7", avatar: "", status: "online" },
    ],
    is_group: true,
    last_message_id: lastId,
    last_message: text,
    last_message_at: "2026-01-01T00:00:00Z",
    unread_count: 0,
  });

  beforeEach(() => {
    resetMessagesStore();
    block([7]);
  });

  it("shows the blocked-message text when a blocked author edits the shown message", () => {
    addMessage(message(7, "first", 4));
    shown(4, "Blocked message");
    handleChatEdited(undefined, {
      message_id: 4,
      channel_id: DM,
      content: "edited words",
      edited_at: "x",
    });
    expect(lastMessage()).toBe("Blocked message");
  });

  it("shows an edit by an author who is not blocked", () => {
    addMessage(message(8, "first", 5));
    shown(5, "first");
    handleChatEdited(undefined, {
      message_id: 5,
      channel_id: DM,
      content: "fixed",
      edited_at: "x",
    });
    expect(lastMessage()).toBe("fixed");
  });

  const unloadedEdit = (blockedIds: readonly number[]): string => {
    block(blockedIds);
    dmStore.setState(() => ({
      channels: [
        {
          ...groupDm(),
          participants: [
            ...groupDm().participants,
            { id: 7, username: "u7", avatar: "", status: "" },
          ],
          lastMessageId: 6,
          lastMessage: "before",
        },
      ],
    }));
    handleChatEdited(undefined, {
      message_id: 6,
      channel_id: DM,
      content: "edited words",
      edited_at: "x",
    });
    return lastMessage();
  };

  it("shows the blocked-message text for an unloaded edit when every member is blocked", () => {
    expect(unloadedEdit([1, 7])).toBe("Blocked message");
  });

  it("shows an unloaded edit when only some members are blocked", () => {
    expect(unloadedEdit([7])).toBe("edited words");
  });

  it("keeps a summary's text out of the preview when every member is blocked", () => {
    block([1, 7]);
    expect(dmChannelFromPayload(summary(9, "secret words")).lastMessage).toBe("Blocked message");
  });

  it("shows a summary's text when only some members are blocked", () => {
    expect(dmChannelFromPayload(summary(9, "group words")).lastMessage).toBe("group words");
  });

  it("keeps a 1:1 summary's text out of the preview when the other person is blocked", () => {
    const oneToOne: DmChannelPayload = {
      ...summary(9, "secret words"),
      recipient: { id: 7, username: "u7", avatar: "", status: "online" },
      recipients: undefined,
      is_group: false,
    };
    expect(dmChannelFromPayload(oneToOne).lastMessage).toBe("Blocked message");
  });

  it("shows a summary's text when the loaded message names an author who is not blocked", () => {
    addMessage(message(1, "my own words", 9));
    expect(dmChannelFromPayload(summary(9, "my own words")).lastMessage).toBe("my own words");
  });

  it("shows a summary's text when nobody in the DM is blocked", () => {
    block([]);
    expect(dmChannelFromPayload(summary(9, "hello all")).lastMessage).toBe("hello all");
  });

  it("hides held previews once a block list arrives after them", () => {
    block([]);
    dmStore.setState(() => ({ channels: [dmChannelFromPayload(summary(9, "secret words"))] }));
    expect(lastMessage()).toBe("secret words");
    block([1, 7]);
    hideBlockedDmPreviews();
    expect(lastMessage()).toBe("Blocked message");
  });
});
