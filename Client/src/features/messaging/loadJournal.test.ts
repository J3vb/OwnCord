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
import type { ChatEditedPayload } from "../../lib/types";
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
const FILE = { id: "f1", filename: "a.png", size: 1, mime: "image/png", url: "/a.png" };

/** Newest-first, as the REST page arrives. */
const page = (...rows: MessageResponse[]): MessageResponse[] => rows;
const withFile = (): MessageResponse[] => page(response(1, { attachments: [FILE] }));
const find = (s: MessagesState, id: number): Message | undefined =>
  s.messagesByChannel.get(1)?.find((m) => m.id === id);

describe("changes that arrive while a history page is in flight", () => {
  const cachedWindow = reduceSetMessages(
    INITIAL_STATE,
    1,
    page(response(3), response(2), response(1)),
    false,
  );

  /** The cached window, reloading, with `frames` applied, then `fetched` installed. */
  function revisit(
    frames: (s: MessagesState) => MessagesState,
    fetched: MessageResponse[],
  ): MessagesState {
    return reduceSetMessages(frames(reduceSetChannelLoading(cachedWindow, 1)), 1, fetched, false);
  }
  const fresh = () => page(response(3), response(2), response(1));

  it("a revisit keeps an edit the page was read before", () => {
    const s = revisit((x) => reduceEditMessage(x, edit(1, "2026-11-11T00:00:01Z")), fresh());
    expect(find(s, 1)?.content).toBe("edited");
    expect(s.loadJournal?.has(1)).toBe(false);
  });

  it("a revisit keeps a delete the page was read before", () => {
    const s = revisit((x) => reduceDeleteMessage(x, { channel_id: 1, message_id: 2 }), fresh());
    expect(find(s, 2)?.deleted).toBe(true);
  });

  it("a revisit keeps a purge the page was read before", () => {
    const s = revisit((x) => reduceBulkDeleteMessages(x, { channel_id: 1, ids: [1, 3] }), fresh());
    expect([find(s, 1)?.deleted, find(s, 3)?.deleted]).toEqual([true, true]);
  });

  it("a revisit keeps a pin the page was read before", () => {
    const s = revisit((x) => reduceSetMessagePinned(x, 1, 3, true), fresh());
    expect(find(s, 3)?.pinned).toBe(true);
  });

  it("a revisit leaves a page's reactions as fetched when a reaction frame arrived during the load", () => {
    const withThree = response(3, { reactions: [{ emoji: "x", count: 3, me: false }] });
    const s = revisit((x) => reduceUpdateReaction(x, reactionFrame, 1), page(withThree));
    expect(find(s, 3)?.reactions).toEqual([{ emoji: "x", count: 3, me: false }]);
  });

  it("a revisit drops a file removed during the load that the page still carries", () => {
    const cached = reduceSetMessages(INITIAL_STATE, 1, withFile(), false);
    const removal: ChatEditedPayload = {
      ...edit(1, ""),
      content: "hi",
      edited_at: null,
      attachments: [],
    };
    let s = reduceSetChannelLoading(cached, 1);
    s = reduceEditMessage(s, removal);
    s = reduceSetMessages(s, 1, withFile(), false);
    expect(find(s, 1)?.attachments).toEqual([]);
  });

  it("a page that carries the very same edit is not overwritten by it", () => {
    const same = { edited_at: "2026-11-11T00:00:01Z", content: "edited", mentions: [5] };
    const s = revisit(
      (x) => reduceEditMessage(x, edit(1, same.edited_at)),
      page(response(1, same)),
    );
    expect(find(s, 1)?.mentions).toEqual([5]);
  });

  it("a second edit in the same second as the page's edit wins", () => {
    const first = { edited_at: "2026-11-11T00:00:01Z", content: "first" };
    const cached = reduceSetMessages(INITIAL_STATE, 1, page(response(1, first)), false);
    let s = reduceSetChannelLoading(cached, 1);
    s = reduceEditMessage(s, { ...edit(1, "2026-11-11T00:00:01Z"), content: "second" });
    s = reduceSetMessages(s, 1, page(response(1, first)), false);
    expect(find(s, 1)?.content).toBe("second");
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
