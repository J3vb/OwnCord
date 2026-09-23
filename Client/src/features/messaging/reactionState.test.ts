import { describe, it, expect } from "vitest";
import {
  reduceAddOptimisticReaction,
  reduceRollbackReaction,
  reduceUpdateReaction,
} from "./reactionState";
import { INITIAL_STATE } from "./messageModel";
import type { Message, MessagesState, PendingReaction } from "./messageModel";
import type { ReactionSummary } from "../../lib/types";

function row(id: number, reactions: readonly ReactionSummary[] = []): Message {
  return {
    id,
    channelId: 1,
    user: { id: 1, username: "me", avatar: null },
    content: "hi",
    replyTo: null,
    attachments: [],
    reactions,
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2026-03-15T10:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

function state(rows: readonly Message[], extra: Partial<MessagesState> = {}): MessagesState {
  return { ...INITIAL_STATE, messagesByChannel: new Map([[1, rows]]), ...extra };
}

const reactionsOf = (s: MessagesState, index = 0): readonly ReactionSummary[] =>
  s.messagesByChannel.get(1)?.[index]?.reactions ?? [];

const add: PendingReaction = { channelId: 1, messageId: 5, emoji: "👍", action: "add" };

describe("reduceAddOptimisticReaction", () => {
  it("adds a new pill as mine and registers the toggle", () => {
    const next = reduceAddOptimisticReaction(state([row(4), row(5)]), "c-1", add);
    expect(reactionsOf(next, 1)).toEqual([{ emoji: "👍", count: 1, me: true }]);
    expect(reactionsOf(next, 0)).toEqual([]);
    expect(next.pendingReactions?.get("c-1")).toBe(add);
  });

  it("bumps an existing pill and keeps the others", () => {
    const existing = [
      { emoji: "🎉", count: 1, me: false },
      { emoji: "👍", count: 2, me: false },
    ];
    const next = reduceAddOptimisticReaction(
      state([row(5, existing)], { pendingReactions: undefined }),
      "c-1",
      add,
    );
    expect(reactionsOf(next)).toEqual([
      { emoji: "🎉", count: 1, me: false },
      { emoji: "👍", count: 3, me: true },
    ]);
  });

  it("removes my pill and drops it at zero", () => {
    const mine = [
      { emoji: "👍", count: 1, me: true },
      { emoji: "🎉", count: 2, me: true },
    ];
    const next = reduceAddOptimisticReaction(state([row(5, mine)]), "c-1", {
      ...add,
      action: "remove",
    });
    expect(reactionsOf(next)).toEqual([{ emoji: "🎉", count: 2, me: true }]);
  });

  it("returns prev by identity for an unloaded channel", () => {
    const prev = state([row(5)]);
    expect(reduceAddOptimisticReaction(prev, "c-1", { ...add, channelId: 9 })).toBe(prev);
  });
});

describe("reduceRollbackReaction", () => {
  it("applies the inverse delta and reports the match", () => {
    const applied = reduceAddOptimisticReaction(state([row(5)]), "c-1", add);
    const { next, found } = reduceRollbackReaction(applied, "c-1");
    expect(found).toBe(true);
    expect(reactionsOf(next)).toEqual([]);
    expect(next.pendingReactions?.size).toBe(0);
  });

  it("reverts a remove by re-adding the pill", () => {
    const removed = reduceAddOptimisticReaction(
      state([row(5, [{ emoji: "👍", count: 1, me: true }])]),
      "c-1",
      { ...add, action: "remove" },
    );
    const { next } = reduceRollbackReaction(removed, "c-1");
    expect(reactionsOf(next)).toEqual([{ emoji: "👍", count: 1, me: true }]);
  });

  it("drops the toggle when its channel is no longer loaded", () => {
    const prev: MessagesState = {
      ...INITIAL_STATE,
      pendingReactions: new Map([["c-1", add]]),
    };
    const { next, found } = reduceRollbackReaction(prev, "c-1");
    expect(found).toBe(true);
    expect(next.pendingReactions?.size).toBe(0);
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
  });

  it("returns prev by identity for an unknown id", () => {
    const prev = state([row(5)]);
    expect(reduceRollbackReaction(prev, "nope")).toEqual({ next: prev, found: false });
    const noMap = { ...prev, pendingReactions: undefined };
    expect(reduceRollbackReaction(noMap, "nope").next).toBe(noMap);
  });
});

describe("reduceUpdateReaction", () => {
  const echo = { message_id: 5, channel_id: 1, emoji: "👍", user_id: 1, action: "add" } as const;

  it("consumes my own echo of a pending toggle instead of re-applying it", () => {
    const applied = reduceAddOptimisticReaction(state([row(5)]), "c-1", add);
    const next = reduceUpdateReaction(applied, echo, 1);
    expect(reactionsOf(next)).toEqual([{ emoji: "👍", count: 1, me: true }]);
    expect(next.pendingReactions?.size).toBe(0);
  });

  it.each([
    ["channel", { channel_id: 2 }],
    ["message", { message_id: 6 }],
    ["emoji", { emoji: "🎉" }],
    ["action", { action: "remove" }],
  ] as const)("applies my echo whose %s differs from the pending toggle", (_, diff) => {
    const prev = state([row(5), row(6)], { pendingReactions: new Map([["c-1", add]]) });
    const next = reduceUpdateReaction(prev, { ...echo, ...diff }, 1);
    expect(next.pendingReactions?.size).toBe(1);
  });

  it("applies another user's reaction as not mine", () => {
    const prev = state([row(5)], { pendingReactions: new Map([["c-1", add]]) });
    const next = reduceUpdateReaction(prev, { ...echo, user_id: 2 }, 1);
    expect(reactionsOf(next)).toEqual([{ emoji: "👍", count: 1, me: false }]);
    expect(next.pendingReactions?.size).toBe(1);
  });

  it("keeps my flag when another user removes", () => {
    const prev = state([row(5, [{ emoji: "👍", count: 2, me: true }])]);
    const next = reduceUpdateReaction(prev, { ...echo, user_id: 2, action: "remove" }, 1);
    expect(reactionsOf(next)).toEqual([{ emoji: "👍", count: 1, me: true }]);
  });

  it("returns prev by identity for an unloaded channel", () => {
    const prev = state([row(5)]);
    expect(reduceUpdateReaction(prev, { ...echo, channel_id: 9 }, 2)).toBe(prev);
  });
});
