import { describe, it, expect } from "vitest";
import {
  reduceSetChannelLoading,
  reduceSetMessages,
  reduceSetChannelLoadError,
} from "./historyWindows";
import {
  reduceBulkDeleteMessages,
  reduceDeleteMessage,
  reduceEditMessage,
  reduceSetMessagePinned,
} from "./messageEdits";
import { reduceUpdateReaction } from "./reactionState";
import { INITIAL_STATE } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";
import type { MessageResponse } from "../../lib/types";

const me = { id: 1, username: "me", avatar: null };

function response(id: number, overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id,
    channel_id: 1,
    user: me,
    content: "hi",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-03-15T10:00:00Z",
    ...overrides,
  };
}

const edit = (id: number, at: string) => ({
  channel_id: 1,
  message_id: id,
  content: "edited",
  edited_at: at,
  mentions: [],
  mentions_everyone: false,
  mention_roles: [],
});
const reactionFrame = {
  channel_id: 1,
  message_id: 3,
  emoji: "x",
  user_id: 9,
  action: "add" as const,
};

/** Newest-first, as the REST page arrives. */
const page = (...rows: MessageResponse[]): MessageResponse[] => rows;
const find = (s: MessagesState, id: number): Message | undefined =>
  s.messagesByChannel.get(1)?.find((m) => m.id === id);

describe("changes that arrive while a history page is in flight", () => {
  const cachedWindow = reduceSetMessages(
    INITIAL_STATE,
    1,
    page(response(3), response(2), response(1)),
    false,
  );

  it("a revisit keeps an edit, a delete and a reaction the page was read before", () => {
    let s = reduceSetChannelLoading(cachedWindow, 1);
    s = reduceEditMessage(s, edit(1, "2026-11-11T00:00:01Z"));
    s = reduceDeleteMessage(s, { channel_id: 1, message_id: 2 });
    s = reduceUpdateReaction(s, reactionFrame, 1);
    s = reduceSetMessagePinned(s, 1, 3, true);
    s = reduceSetMessages(s, 1, page(response(3), response(2), response(1)), false);
    expect(find(s, 1)?.content).toBe("edited");
    expect(find(s, 2)?.deleted).toBe(true);
    expect(find(s, 3)?.reactions).toEqual([{ emoji: "x", count: 1, me: false }]);
    expect(find(s, 3)?.pinned).toBe(true);
    expect(s.loadJournal?.has(1)).toBe(false);
  });

  it("a first visit applies a delete and a purge that found no row yet", () => {
    let s = reduceSetChannelLoading(INITIAL_STATE, 1);
    s = reduceDeleteMessage(s, { channel_id: 1, message_id: 2 });
    s = reduceBulkDeleteMessages(s, { channel_id: 1, ids: [1] });
    s = reduceSetMessages(s, 1, page(response(2), response(1)), false);
    expect(find(s, 2)?.deleted).toBe(true);
    expect(find(s, 1)?.deleted).toBe(true);
  });

  it("a page that already carries the edit, or a later one, is left as fetched", () => {
    let s = reduceSetChannelLoading(cachedWindow, 1);
    s = reduceEditMessage(s, edit(1, "2026-11-11T00:00:01Z"));
    const later = { edited_at: "2026-11-11T00:00:05Z", content: "newest" };
    s = reduceSetMessages(s, 1, page(response(3), response(2), response(1, later)), false);
    expect(find(s, 1)?.content).toBe("newest");
  });

  it("records nothing for a channel that is not loading, and drops the journal on a failed load", () => {
    const idle = reduceDeleteMessage(cachedWindow, { channel_id: 1, message_id: 2 });
    expect(idle.loadJournal?.has(1)).toBe(false);
    const loading = reduceSetChannelLoading(cachedWindow, 1);
    expect(reduceSetChannelLoadError(loading, 1).loadJournal?.has(1)).toBe(false);
  });
});
