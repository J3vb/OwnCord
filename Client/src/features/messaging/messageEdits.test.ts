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

const att = (id: string) => ({
  id,
  filename: `${id}.png`,
  size: 1,
  mime: "image/png",
  url: "/u",
});

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

  it("a call row's end replaces `call`, and editedAt stays null", () => {
    const call = { started_at: "T0", ended_at: null, participants: [1] };
    const withCall: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([
        [1, [row(8, { kind: "call", call, content: "started a call." })]],
      ]),
    };
    const ended = { started_at: "T0", ended_at: "T1", participants: [1, 2] };
    const next = reduceEditMessage(withCall, {
      message_id: 8,
      channel_id: 1,
      content: "started a call that lasted a few seconds.",
      edited_at: null,
      kind: "call",
      call: ended,
    });
    expect(list(next)[0]).toMatchObject({ kind: "call", call: ended, editedAt: null });
  });

  it("a call end without a kind marks the row as a call, and a stated kind wins", () => {
    const call = { started_at: "T0", ended_at: "T1", participants: [1] };
    const bare = reduceEditMessage(prev, {
      message_id: 2,
      channel_id: 1,
      content: "call",
      edited_at: null,
      call,
    });
    expect(list(bare)[1]?.kind).toBe("call");
    const stated = reduceEditMessage(prev, {
      message_id: 2,
      channel_id: 1,
      content: "call",
      edited_at: null,
      kind: "group_call",
      call,
    });
    expect(list(stated)[1]?.kind).toBe("group_call");
  });

  it("an edit without a call leaves the row's kind alone", () => {
    const withKind: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([[1, [row(2, { kind: "member_join" })]]]),
    };
    const next = reduceEditMessage(withKind, {
      message_id: 2,
      channel_id: 1,
      content: "x",
      edited_at: "T2",
    });
    expect(list(next)[0]?.kind).toBe("member_join");
  });

  it("an end for a call row not in the store is a no-op that creates nothing", () => {
    const next = reduceEditMessage(prev, {
      message_id: 99,
      channel_id: 1,
      content: "x",
      edited_at: null,
      kind: "call",
      call: { started_at: "T0", ended_at: "T1", participants: [1] },
    });
    expect(list(next).map((m) => m.id)).toEqual([1, 2, 3]);
    expect(list(next).some((m) => m.kind === "call")).toBe(false);
  });

  it("replaces the attachments when the payload carries the remaining list", () => {
    const withFiles: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([[1, [row(5, { attachments: [att("a"), att("b")] })]]]),
    };
    const next = reduceEditMessage(withFiles, {
      message_id: 5,
      channel_id: 1,
      content: "hi",
      edited_at: null,
      attachments: [att("b")],
    });
    expect(list(next)[0]?.attachments.map((a) => a.id)).toEqual(["b"]);
    expect(list(next)[0]?.editedAt).toBeNull();

    const none = reduceEditMessage(withFiles, {
      message_id: 5,
      channel_id: 1,
      content: "hi",
      edited_at: null,
      attachments: [],
    });
    expect(list(none)[0]?.attachments).toEqual([]);
  });

  it("leaves the attachments alone when the payload has none", () => {
    const files = [{ id: "a", filename: "a.png", size: 1, mime: "image/png", url: "/u" }];
    const withFiles: MessagesState = {
      ...INITIAL_STATE,
      messagesByChannel: new Map([[1, [row(5, { attachments: files })]]]),
    };
    const next = reduceEditMessage(withFiles, {
      message_id: 5,
      channel_id: 1,
      content: "edited",
      edited_at: "T2",
    });
    expect(list(next)[0]?.attachments).toBe(files);
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

  it("leaves the message lists untouched for an unloaded channel", () => {
    const next = reduceSetMessagePinned(prev, 9, 2, true);
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
  });

  it("bumps the channel's pin revision on every change, loaded or not", () => {
    const first = reduceSetMessagePinned(prev, 1, 2, true);
    expect(first.pinRevision?.get(1)).toBe(1);
    expect(reduceSetMessagePinned(first, 1, 2, false).pinRevision?.get(1)).toBe(2);
    const other = reduceSetMessagePinned(first, 9, 2, true);
    expect(other.pinRevision?.get(9)).toBe(1);
    expect(other.pinRevision?.get(1)).toBe(1);
  });

  it("bumps the message's own pin revision, apart from other messages", () => {
    const first = reduceSetMessagePinned(prev, 1, 2, true);
    const second = reduceSetMessagePinned(first, 1, 3, true);
    expect(second.messagePinRevision?.get(2)).toBe(1);
    expect(second.messagePinRevision?.get(3)).toBe(1);
    expect(reduceSetMessagePinned(second, 9, 2, false).messagePinRevision?.get(2)).toBe(2);
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
