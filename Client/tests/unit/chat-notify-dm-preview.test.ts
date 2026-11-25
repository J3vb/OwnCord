import { describe, it, expect, beforeEach, vi } from "vitest";
import { noteDmMessage } from "../../src/features/messaging/chatNotify";
import { handleChatEdited } from "../../src/features/messaging/wsHandlers";
import { applyReadyBlocks } from "../../src/features/direct-messages/wsHandlers";
import { dmPreviewText } from "../../src/features/direct-messages/SidebarDmHelpers";
import { watchBlockedPreviews } from "../../src/features/direct-messages/blockedPreviewText";
import { toggleBlock } from "../../src/features/blocks/blockActions";
import { blocksStore, setBlockedByMe } from "../../src/stores/blocks.store";
import { addMessage, messagesStore, resetMessagesStore } from "../../src/stores/messages.store";
import { dmChannelFromPayload, dmStore, type DmChannel } from "../../src/stores/dm.store";
import type { DispatchApi, Payload } from "../../src/features/connection/dispatchContext";
import type { DmChannelPayload } from "../../src/lib/types";

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

/** What the DM row draws for the held DM. */
const rowText = (): string => {
  const dm = dmStore.getState().channels[0];
  return dm === undefined ? "" : dmPreviewText(dm);
};

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

describe("DM row preview from edits and server summaries", () => {
  const block = (ids: readonly number[]): void =>
    blocksStore.setState((prev) => ({ ...prev, blockedByMe: new Set(ids) }));
  const shown = (id: number, text: string): void =>
    dmStore.setState(() => ({
      channels: [{ ...groupDm(), lastMessageId: id, lastMessage: text, lastMessageAt: "x" }],
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
  const held = (p: DmChannelPayload): void =>
    dmStore.setState(() => ({ channels: [dmChannelFromPayload(p)] }));
  const edit = (id: number, content: string): void =>
    handleChatEdited(undefined, { message_id: id, channel_id: DM, content, edited_at: "x" });

  beforeEach(() => {
    resetMessagesStore();
    block([7]);
  });

  it("keeps a blocked author's edit in the store and shows the label on the row", () => {
    addMessage(message(7, "first", 4));
    shown(4, "first");
    edit(4, "edited words");
    expect(lastMessage()).toBe("edited words");
    expect(rowText()).toBe("Blocked message");
  });

  it("shows an edit by an author who is not blocked", () => {
    addMessage(message(8, "first", 5));
    shown(5, "first");
    edit(5, "fixed");
    expect(rowText()).toBe("fixed");
  });

  const unloadedEdit = (blockedIds: readonly number[]): string => {
    block(blockedIds);
    held(summary(6, "before"));
    edit(6, "edited words");
    expect(lastMessage()).toBe("edited words");
    return rowText();
  };

  it("shows the label for an unloaded edit when every member is blocked", () => {
    expect(unloadedEdit([1, 7])).toBe("Blocked message");
  });

  it("shows an unloaded edit when only some members are blocked", () => {
    expect(unloadedEdit([7])).toBe("edited words");
  });

  it("holds a summary's text and shows the label when every member is blocked", () => {
    block([1, 7]);
    held(summary(9, "secret words"));
    expect(lastMessage()).toBe("secret words");
    expect(rowText()).toBe("Blocked message");
  });

  it("shows a group summary's text when only some members are blocked and no author is loaded", () => {
    held(summary(9, "group words"));
    expect(rowText()).toBe("group words");
  });

  it("shows the label for a 1:1 summary when the other person is blocked", () => {
    held({
      ...summary(9, "secret words"),
      recipient: { id: 7, username: "u7", avatar: "", status: "online" },
      recipients: undefined,
      is_group: false,
    });
    expect(rowText()).toBe("Blocked message");
  });

  it("shows a summary's text when the loaded message names an author who is not blocked", () => {
    // The user's own message in a DM where everyone else is blocked.
    addMessage(message(3, "my own words", 9));
    block([1, 7]);
    held(summary(9, "my own words"));
    expect(rowText()).toBe("my own words");
  });

  it("shows a summary's text when nobody in the DM is blocked", () => {
    block([]);
    held(summary(9, "hello all"));
    expect(rowText()).toBe("hello all");
  });
});

describe("DM row preview follows the block list", () => {
  const ONE_TO_ONE: DmChannelPayload = {
    channel_id: DM,
    recipient: { id: 7, username: "u7", avatar: "", status: "online" },
    last_message_id: 9,
    last_message: "real words",
    last_message_at: "2026-01-01T00:00:00Z",
    unread_count: 0,
  };
  const flushStores = (): void => {
    blocksStore.flush();
    dmStore.flush();
  };
  const api = { blockUser: vi.fn(async () => {}), unblockUser: vi.fn(async () => {}) };
  const deps = { api, notify: (): void => {} };
  let redraw = vi.fn<() => void>();
  let stop: () => void = () => {};

  beforeEach(() => {
    stop();
    resetMessagesStore();
    setBlockedByMe([]);
    dmStore.setState(() => ({ channels: [dmChannelFromPayload(ONE_TO_ONE)] }));
    flushStores();
    redraw = vi.fn<() => void>();
    stop = watchBlockedPreviews(redraw);
  });

  it("hides the row text when the block list arrives after the summaries", async () => {
    expect(rowText()).toBe("real words");
    const listBlocks = vi.fn(async () => ({ blocked_user_ids: [7] }));
    applyReadyBlocks({ listBlocks } as Partial<DispatchApi> as DispatchApi, "resume");
    await vi.waitFor(() => expect(blocksStore.getState().blockedByMe.has(7)).toBe(true));
    flushStores();
    expect(rowText()).toBe("Blocked message");
    expect(redraw).toHaveBeenCalledTimes(1);
  });

  it("brings the text back when a refreshed list no longer has the user", () => {
    setBlockedByMe([7]);
    flushStores();
    expect(rowText()).toBe("Blocked message");
    setBlockedByMe([]);
    flushStores();
    expect(lastMessage()).toBe("real words");
    expect(rowText()).toBe("real words");
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  it("hides the text on a local block and brings it back on a local unblock", async () => {
    await toggleBlock(deps, 7, "u7", true);
    flushStores();
    expect(rowText()).toBe("Blocked message");
    await toggleBlock(deps, 7, "u7", false);
    flushStores();
    expect(rowText()).toBe("real words");
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  it("shows the label once a loaded message names a blocked group author", () => {
    dmStore.setState(() => ({
      channels: [{ ...groupDm(), lastMessageId: 9, lastMessage: "real words", lastMessageAt: "x" }],
    }));
    setBlockedByMe([7]);
    flushStores();
    expect(rowText()).toBe("real words");
    addMessage(message(7, "real words", 9));
    messagesStore.flush();
    expect(rowText()).toBe("Blocked message");
    expect(redraw).toHaveBeenCalledTimes(1);
  });

  it("does not redraw for a block that leaves every row as it was", () => {
    setBlockedByMe([42]);
    flushStores();
    expect(rowText()).toBe("real words");
    expect(redraw).not.toHaveBeenCalled();
  });
});
