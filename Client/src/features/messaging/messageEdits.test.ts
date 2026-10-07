import { describe, it, expect } from "vitest";
import {
  reduceEditMessage,
  reduceDeleteMessage,
  reduceBulkDeleteMessages,
  reduceSetMessagePinned,
} from "./messageEdits";
import { INITIAL_STATE } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";

function row(id: number, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: 1,
    user: { id: 1, username: "me", avatar: null },
    content: "hi",
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2026-03-15T10:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
}

const prev: MessagesState = {
  ...INITIAL_STATE,
  messagesByChannel: new Map([[1, [row(1), row(2), row(3, { deleted: true })]]]),
};
const list = (s: MessagesState): readonly Message[] => s.messagesByChannel.get(1) ?? [];

describe("reduceEditMessage", () => {
  it("rewrites content, edit time and mentions of the matching row only", () => {
    const next = reduceEditMessage(prev, {
      message_id: 2,
      channel_id: 1,
      content: "edited",
      edited_at: "T2",
      mentions: [4],
      mentions_everyone: true,
    });
    expect(list(next)[1]).toMatchObject({
      content: "edited",
      editedAt: "T2",
      mentions: [4],
      mentionsEveryone: true,
    });
    expect(list(next)[0]).toBe(list(prev)[0]);
  });

  it("returns prev by identity for an unloaded channel", () => {
    const edit = { message_id: 2, channel_id: 9, content: "x", edited_at: "T2" };
    expect(reduceEditMessage(prev, edit)).toBe(prev);
  });
});

describe("reduceDeleteMessage", () => {
  it("tombstones the matching row only", () => {
    const next = reduceDeleteMessage(prev, { message_id: 1, channel_id: 1 });
    expect(list(next).map((m) => m.deleted)).toEqual([true, false, true]);
  });

  it("returns prev by identity for an unloaded channel", () => {
    expect(reduceDeleteMessage(prev, { message_id: 1, channel_id: 9 })).toBe(prev);
  });
});

describe("reduceBulkDeleteMessages", () => {
  it("tombstones every purged row in one pass", () => {
    const next = reduceBulkDeleteMessages(prev, { channel_id: 1, ids: [1, 2, 99] });
    expect(list(next).map((m) => m.deleted)).toEqual([true, true, true]);
  });

  it("returns prev by identity when nothing new would be deleted", () => {
    expect(reduceBulkDeleteMessages(prev, { channel_id: 1, ids: [3, 99] })).toBe(prev);
    expect(reduceBulkDeleteMessages(prev, { channel_id: 9, ids: [1] })).toBe(prev);
  });
});

describe("reduceSetMessagePinned", () => {
  it("sets the pin flag of the matching row only", () => {
    const next = reduceSetMessagePinned(prev, 1, 2, true);
    expect(list(next).map((m) => m.pinned)).toEqual([false, true, false]);
    expect(list(reduceSetMessagePinned(next, 1, 2, false))[1]?.pinned).toBe(false);
  });

  it("returns prev by identity for an unloaded channel", () => {
    expect(reduceSetMessagePinned(prev, 9, 2, true)).toBe(prev);
  });
});

const snippet = (id: number, userId = 9) => ({
  id,
  user: { id: userId, username: "old", avatar: null },
  content: "secret",
  deleted: false,
  has_attachments: false,
});
const redacted = (id: number) => ({
  id,
  user: null,
  content: "",
  deleted: true,
  has_attachments: false,
});

describe("reply snippets of a deleted parent", () => {
  // Parents 50 and 51 are outside the loaded window.
  const withReplies: MessagesState = {
    ...INITIAL_STATE,
    messagesByChannel: new Map([
      [
        1,
        [
          row(10, { replyTo: 50, referencedMessage: snippet(50) }),
          row(11, { replyTo: 51, referencedMessage: snippet(51, 8) }),
          row(12),
        ],
      ],
    ]),
  };

  it("redacts the snippet when the parent is deleted, even outside the window", () => {
    const next = reduceDeleteMessage(withReplies, { message_id: 50, channel_id: 1 });
    expect(list(next)[0]!.referencedMessage).toStrictEqual(redacted(50));
    expect(list(next)[1]!.referencedMessage).toStrictEqual(snippet(51, 8));
  });

  it("redacts every purged parent on a bulk delete", () => {
    const next = reduceBulkDeleteMessages(withReplies, { channel_id: 1, ids: [50, 51] });
    expect(list(next)[0]!.referencedMessage).toStrictEqual(redacted(50));
    expect(list(next)[1]!.referencedMessage).toStrictEqual(redacted(51));
  });
});

const edit = (content: string) => ({
  message_id: 50,
  channel_id: 1,
  content,
  edited_at: "T2",
});

describe("reply snippets of an edited parent", () => {
  // Parent 50 is outside the loaded window.
  const withReply: MessagesState = {
    ...INITIAL_STATE,
    messagesByChannel: new Map([
      [
        1,
        [row(10, { replyTo: 50, referencedMessage: { ...snippet(50), content: "old" } }), row(12)],
      ],
    ]),
  };

  it("an edit refreshes the snippet of replies whose parent is outside the window", () => {
    const next = reduceEditMessage(withReply, edit("new"));
    expect(list(next)[0]!.referencedMessage).toStrictEqual({
      ...snippet(50),
      content: "new",
    });
    expect(list(next)[1]).toBe(list(withReply)[1]);
  });

  it("cuts the refreshed snippet to the server's 100 code points", () => {
    const next = reduceEditMessage(withReply, edit("😀".repeat(150)));
    expect(list(next)[0]!.referencedMessage!.content).toBe("😀".repeat(100));
  });
});
