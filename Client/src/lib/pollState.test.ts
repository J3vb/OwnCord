import { describe, expect, it } from "vitest";
import { INITIAL_STATE, chatPayloadToMessage } from "../features/messaging/messageModel";
import type { Message, MessagesState } from "../features/messaging/messageModel";
import { reduceAddMessage, reduceApplyServerMessage } from "../features/messaging/liveMessages";
import { reduceSetAroundMessages, reduceSetMessages } from "../features/messaging/historyWindows";
import { mergePoll, reducePollUpdate, reducePollVoteOk } from "./pollState";
import type {
  ChatMessagePayload,
  MessageResponse,
  PollInfo,
  PollUpdatePayload,
  PollView,
} from "./types";

const ME = 7;

function info(over: Partial<PollInfo["results"]> = {}, top: Partial<PollInfo> = {}): PollInfo {
  return {
    question: "Lunch?",
    answers: [
      { answer_id: 1, text: "Pizza", emoji: "🍕" },
      { answer_id: 2, text: "Sushi", emoji: null },
    ],
    allow_multiselect: false,
    expires_at: "2026-10-22T12:00:00Z",
    ended: false,
    ended_at: null,
    results: {
      version: 0,
      total_voters: 0,
      counts: [
        { answer_id: 1, count: 0 },
        { answer_id: 2, count: 0 },
      ],
      me: [],
      ...over,
    },
    ...top,
  };
}

const view = (over: Partial<PollInfo["results"]> = {}, top: Partial<PollInfo> = {}): PollView => {
  const poll = info(over, top);
  return { ...poll, selfVersion: poll.results.version };
};

function payload(id: number, poll: PollInfo): ChatMessagePayload {
  return {
    id,
    channel_id: 1,
    user: { id: 1, username: "alice", avatar: null },
    content: "📊 Lunch?",
    reply_to: null,
    attachments: [],
    timestamp: "2026-10-21T12:00:00Z",
    poll,
  };
}

const row = (id: number, poll: PollInfo): Message => chatPayloadToMessage(payload(id, poll));

const state = (rows: readonly Message[]): MessagesState => ({
  ...INITIAL_STATE,
  messagesByChannel: new Map([[1, rows]]),
});

const pollOf = (s: MessagesState, index = 0): PollView => s.messagesByChannel.get(1)![index]!.poll!;

function update(over: Partial<PollUpdatePayload> = {}): PollUpdatePayload {
  return {
    channel_id: 1,
    message_id: 5,
    version: 1,
    total_voters: 1,
    counts: [
      { answer_id: 1, count: 1 },
      { answer_id: 2, count: 0 },
    ],
    ended: false,
    ended_at: null,
    ...over,
  };
}

const response = (id: number, poll: PollInfo): MessageResponse => ({
  id,
  channel_id: 1,
  user: { id: 1, username: "alice", avatar: null },
  content: "📊 Lunch?",
  reply_to: null,
  attachments: [],
  reactions: [],
  pinned: false,
  edited_at: null,
  deleted: false,
  timestamp: "2026-10-21T12:00:00Z",
  poll,
});

describe("reducePollUpdate", () => {
  it("takes a higher version whole: counts, voters and the end", () => {
    const next = reducePollUpdate(
      state([row(5, info())]),
      update({ version: 3, total_voters: 4 }),
      ME,
    );
    expect(pollOf(next).results.version).toBe(3);
    expect(pollOf(next).results.total_voters).toBe(4);
    expect(pollOf(next).results.counts[0]!.count).toBe(1);
  });

  it("drops a frame below the held version (frames can arrive out of order)", () => {
    const s = state([row(5, info({ version: 4, total_voters: 9 }))]);
    expect(reducePollUpdate(s, update({ version: 3 }), ME)).toBe(s);
    expect(reducePollUpdate(s, update({ version: 4 }), ME)).toBe(s);
  });

  it("applies updates in any arrival order and ends on the highest", () => {
    const frames = [
      update({ version: 1, total_voters: 1 }),
      update({ version: 2, total_voters: 2 }),
      update({ version: 3, total_voters: 3 }),
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
    ]) {
      let s = state([row(5, info())]);
      for (const i of order) s = reducePollUpdate(s, frames[i]!, ME);
      expect(pollOf(s).results.version).toBe(3);
      expect(pollOf(s).results.total_voters).toBe(3);
    }
  });

  it("is a no-op for a message that is not loaded or not a poll", () => {
    const plain: Message = { ...row(5, info()) };
    delete (plain as { poll?: PollView }).poll;
    const s = state([plain]);
    expect(reducePollUpdate(s, update(), ME)).toBe(s);
    expect(reducePollUpdate(s, update({ message_id: 99 }), ME)).toBe(s);
    expect(reducePollUpdate(s, update({ channel_id: 2 }), ME)).toBe(s);
  });

  it("marks the poll ended with its end time, and keeps it ended", () => {
    const s = state([row(5, info({ version: 1 }))]);
    const ended = reducePollUpdate(
      s,
      update({ version: 2, ended: true, ended_at: "2026-10-22T12:00:01Z" }),
      ME,
    );
    expect(pollOf(ended).ended).toBe(true);
    expect(pollOf(ended).ended_at).toBe("2026-10-22T12:00:01Z");
    const later = reducePollUpdate(ended, update({ version: 3, ended: false }), ME);
    expect(pollOf(later).ended).toBe(true);
  });

  it("moves the viewer's selection only from their own frame", () => {
    const s = state([row(5, info())]);
    const stranger = reducePollUpdate(s, update({ version: 1, user_id: 9, answer_ids: [2] }), ME);
    expect(pollOf(stranger).results.me).toEqual([]);
    const mine = reducePollUpdate(
      stranger,
      update({ version: 2, user_id: ME, answer_ids: [1] }),
      ME,
    );
    expect(pollOf(mine).results.me).toEqual([1]);
    expect(pollOf(mine).selfVersion).toBe(2);
  });

  it("two devices: an older own vote after a stranger's newer one keeps the newest own selection", () => {
    // Device B voted at v4, a stranger at v5, device A's earlier vote (v3) arrives last.
    let s = state([row(5, info({ version: 2, me: [] }))]);
    s = reducePollUpdate(s, update({ version: 4, user_id: ME, answer_ids: [2] }), ME);
    s = reducePollUpdate(s, update({ version: 5, user_id: 9, answer_ids: [1] }), ME);
    s = reducePollUpdate(s, update({ version: 3, user_id: ME, answer_ids: [1] }), ME);
    expect(pollOf(s).results.version).toBe(5);
    expect(pollOf(s).results.me).toEqual([2]);
    expect(pollOf(s).selfVersion).toBe(4);
  });

  it("an own vote that arrives after a stranger's newer frame still sets `me`, but not the counts", () => {
    let s = state([row(5, info({ version: 2 }))]);
    s = reducePollUpdate(
      s,
      update({ version: 6, total_voters: 6, user_id: 9, answer_ids: [2] }),
      ME,
    );
    s = reducePollUpdate(
      s,
      update({ version: 5, total_voters: 5, user_id: ME, answer_ids: [1] }),
      ME,
    );
    expect(pollOf(s).results.total_voters).toBe(6);
    expect(pollOf(s).results.version).toBe(6);
    expect(pollOf(s).results.me).toEqual([1]);
  });

  it("an own removal ([]) is a selection too", () => {
    let s = state([row(5, info({ version: 1, me: [2] }))]);
    s = reducePollUpdate(s, update({ version: 2, user_id: ME, answer_ids: [] }), ME);
    expect(pollOf(s).results.me).toEqual([]);
  });
});

describe("reducePollVoteOk", () => {
  it("sets the selection ahead of the counts, by the self watermark", () => {
    const s = state([row(5, info())]);
    const ok = reducePollVoteOk(s, { message_id: 5, version: 3, answer_ids: [2] });
    expect(pollOf(ok).results.me).toEqual([2]);
    expect(pollOf(ok).results.version).toBe(0);
    // The poll_update at the same version then brings the counts and changes nothing about `me`.
    const counted = reducePollUpdate(ok, update({ version: 3, user_id: ME, answer_ids: [2] }), ME);
    expect(pollOf(counted).results.version).toBe(3);
    expect(pollOf(counted).results.me).toEqual([2]);
  });

  it("ignores an acknowledgement older than the selection held, and an unknown message", () => {
    const s = state([row(5, info({ version: 4, me: [1] }))]);
    expect(reducePollVoteOk(s, { message_id: 5, version: 3, answer_ids: [2] })).toBe(s);
    expect(reducePollVoteOk(s, { message_id: 99, version: 9, answer_ids: [2] })).toBe(s);
  });
});

describe("mergePoll", () => {
  it("keeps the higher version and its counts", () => {
    const held = view({ version: 5, total_voters: 5 });
    const replay = view({ version: 0 });
    expect(mergePoll(held, replay)!.results.version).toBe(5);
    expect(mergePoll(replay, held)).toBe(held);
  });

  it("takes the incoming copy on equal versions", () => {
    const prev = view({ version: 3, total_voters: 3 });
    const next = view({ version: 3, total_voters: 3 });
    expect(mergePoll(prev, next)).toBe(next);
  });

  it("keeps `me` by its own watermark, apart from the counts", () => {
    const held: PollView = { ...view({ version: 5, me: [2] }), selfVersion: 4 };
    const page: PollView = { ...view({ version: 3, me: [1] }), selfVersion: 3 };
    const merged = mergePoll(held, page)!;
    expect(merged.results.version).toBe(5);
    expect(merged.results.me).toEqual([2]);
    expect(merged.selfVersion).toBe(4);
    // A fresher page wins both.
    const fresh: PollView = { ...view({ version: 9, me: [1] }), selfVersion: 9 };
    expect(mergePoll(held, fresh)).toBe(fresh);
  });

  it("takes the page's newer selection even when the held counts are newer", () => {
    const held: PollView = { ...view({ version: 8, me: [] }), selfVersion: 2 };
    const page: PollView = { ...view({ version: 6, me: [1] }), selfVersion: 6 };
    const merged = mergePoll(held, page)!;
    expect(merged.results.version).toBe(8);
    expect(merged.results.me).toEqual([1]);
    expect(merged.selfVersion).toBe(6);
  });

  it("never reopens an ended poll", () => {
    const ended = view({ version: 4 }, { ended: true, ended_at: "2026-10-22T12:00:01Z" });
    const stale = view({ version: 2 });
    const merged = mergePoll(ended, stale)!;
    expect(merged.ended).toBe(true);
    expect(merged.ended_at).toBe("2026-10-22T12:00:01Z");
  });

  it("passes through when either side has no poll", () => {
    const poll = view();
    expect(mergePoll(undefined, poll)).toBe(poll);
    expect(mergePoll(poll, undefined)).toBeUndefined();
  });
});

const held = (): MessagesState =>
  reducePollUpdate(
    state([row(5, info())]),
    update({ version: 4, total_voters: 4, user_id: ME, answer_ids: [2] }),
    ME,
  );

describe("a poll does not go back when a row is replaced by id", () => {
  it("a replayed chat_message (version 0) keeps the counts and the selection", () => {
    const next = reduceAddMessage(held(), row(5, info()));
    expect(pollOf(next).results.version).toBe(4);
    expect(pollOf(next).results.total_voters).toBe(4);
    expect(pollOf(next).results.me).toEqual([2]);
  });

  it("an authoritative single-row refresh older than the held copy keeps it", () => {
    const next = reduceApplyServerMessage(
      held(),
      response(5, info({ version: 2, total_voters: 2 })),
    );
    expect(pollOf(next).results.version).toBe(4);
  });

  it("a history page fetched before a newer update keeps the newer counts", () => {
    const s: MessagesState = { ...held(), loadedChannels: new Set([1]) };
    const next = reduceSetMessages(
      s,
      1,
      [response(5, info({ version: 2, total_voters: 2 }))],
      false,
    );
    expect(pollOf(next).results.version).toBe(4);
    expect(pollOf(next).results.me).toEqual([2]);
  });

  it("a history page that is newer wins, counts and selection", () => {
    const next = reduceSetMessages(
      held(),
      1,
      [response(5, info({ version: 9, total_voters: 9, me: [1] }))],
      false,
    );
    expect(pollOf(next).results.version).toBe(9);
    expect(pollOf(next).results.me).toEqual([1]);
  });

  it("an around-window keeps a newer held copy as well", () => {
    const next = reduceSetAroundMessages(
      held(),
      1,
      [response(5, info({ version: 1 }))],
      false,
      false,
    );
    expect(pollOf(next).results.version).toBe(4);
  });

  it("a history page of a channel with no loaded copy is taken as it is", () => {
    const next = reduceSetMessages(
      state([]),
      1,
      [response(5, info({ version: 2, me: [1] }))],
      false,
    );
    expect(pollOf(next).results.version).toBe(2);
    expect(pollOf(next).selfVersion).toBe(2);
  });
});
