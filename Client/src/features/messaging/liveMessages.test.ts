import { describe, it, expect } from "vitest";
import {
  reduceAddMessage,
  reduceAddOptimisticMessage,
  reduceMarkSendFailed,
  reduceRemoveOptimistic,
  reduceConfirmSend,
  findSendChannel,
  reduceApplyServerMessage,
} from "./liveMessages";
import { INITIAL_STATE, MAX_MESSAGES_PER_CHANNEL } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";
import type { MessageResponse } from "../../lib/types";

const me = { id: 1, username: "me", avatar: null };
const bob = { id: 2, username: "bob", avatar: null };

function row(overrides: Partial<Message>): Message {
  return {
    id: 0,
    channelId: 1,
    user: me,
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

function state(
  rows: readonly Message[],
  extra: Partial<MessagesState> = {},
  channelId = 1,
): MessagesState {
  return { ...INITIAL_STATE, messagesByChannel: new Map([[channelId, rows]]), ...extra };
}

const pending = row({ status: "pending", correlationId: "c-1" });
const pendingSends = new Map([["c-1", 1]]);

describe("reduceAddMessage", () => {
  it("appends into an empty channel", () => {
    const next = reduceAddMessage(INITIAL_STATE, row({ id: 5, channelId: 3 }));
    expect(next.messagesByChannel.get(3)?.map((m) => m.id)).toEqual([5]);
  });

  it("replaces a row with the same real id in place", () => {
    const prev = state([row({ id: 5, content: "old" }), row({ id: 6 })]);
    const next = reduceAddMessage(prev, row({ id: 5, content: "new" }));
    expect(next.messagesByChannel.get(1)?.map((m) => [m.id, m.content])).toEqual([
      [5, "new"],
      [6, "hi"],
    ]);
  });

  it("does not treat an optimistic id of 0 as a real id", () => {
    const prev = state([row({ id: 0, user: bob, status: "pending", correlationId: "x" })]);
    const next = reduceAddMessage(prev, row({ id: 0 }));
    expect(next.messagesByChannel.get(1)).toHaveLength(2);
  });

  it("consumes the optimistic twin of a history row carrying the same client id", () => {
    const history = row({ id: 5 });
    const twin = row({ status: "pending", correlationId: "c-1", clientMessageId: "m-1" });
    const prev = state([history, twin], { pendingSends });
    const next = reduceAddMessage(prev, row({ id: 5, clientMessageId: "m-1" }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([5]);
    expect(next.pendingSends.size).toBe(0);
  });

  it("reconciles the oldest pending echo and drops its correlation", () => {
    const prev = state([pending, row({ status: "pending", correlationId: "c-2" })], {
      pendingSends: new Map([
        ["c-1", 1],
        ["c-2", 1],
      ]),
    });
    const next = reduceAddMessage(prev, row({ id: 9 }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([9, 0]);
    expect([...next.pendingSends.keys()]).toEqual(["c-2"]);
  });

  it("returns prev by identity for a detached channel", () => {
    const prev = state([row({ id: 1 })], { detachedChannels: new Set([1]) });
    expect(reduceAddMessage(prev, row({ id: 2, user: bob }))).toBe(prev);
  });

  it("inserts ahead of the trailing unreconciled run", () => {
    const failed = row({ status: "failed", correlationId: "c-2", errorCode: "SLOW_MODE" });
    const prev = state([row({ id: 1 }), pending, failed]);
    const next = reduceAddMessage(prev, row({ id: 2, user: bob, content: "yo" }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([1, 2, 0, 0]);
  });

  it("evicts the oldest row past the cap and marks more above", () => {
    const full = Array.from({ length: MAX_MESSAGES_PER_CHANNEL }, (_, i) => row({ id: i + 1 }));
    const next = reduceAddMessage(state(full), row({ id: 9999, user: bob }));
    const list = next.messagesByChannel.get(1) ?? [];
    expect(list).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(list[0]?.id).toBe(2);
    expect(list.at(-1)?.id).toBe(9999);
    expect(next.hasMore.get(1)).toBe(true);
  });

  it("leaves hasMore alone below the cap", () => {
    const next = reduceAddMessage(state([row({ id: 1 })]), row({ id: 2 }));
    expect(next.hasMore.has(1)).toBe(false);
  });
});

describe("reduceAddOptimisticMessage", () => {
  it("appends the row and registers its correlation", () => {
    const next = reduceAddOptimisticMessage(
      state([row({ id: 1 })]),
      { channelId: 1, correlationId: "c-1" },
      pending,
    );
    expect(next.messagesByChannel.get(1)?.at(-1)).toBe(pending);
    expect(next.pendingSends.get("c-1")).toBe(1);
  });
});

describe("an uploading row (WP 3A-9)", () => {
  const uploading = row({ status: "uploading", correlationId: "u-1", content: "files" });
  const uploading2 = row({ status: "uploading", correlationId: "u-2", content: "more files" });

  it("is not registered in pendingSends", () => {
    const next = reduceAddOptimisticMessage(
      state([row({ id: 1 })]),
      { channelId: 1, correlationId: "u-1" },
      uploading,
    );
    expect(next.messagesByChannel.get(1)?.at(-1)).toBe(uploading);
    expect(next.pendingSends.size).toBe(0);
  });

  it("goes after the rows already there, including earlier uploading ones", () => {
    const next = reduceAddOptimisticMessage(
      state([row({ id: 1 }), pending, uploading]),
      { channelId: 1, correlationId: "u-2" },
      uploading2,
    );
    expect(next.messagesByChannel.get(1)?.map((m) => m.correlationId)).toEqual([
      null,
      "c-1",
      "u-1",
      "u-2",
    ]);
  });

  it("keeps a pending optimistic row ahead of the trailing uploading rows", () => {
    const prev = state([row({ id: 1 }), uploading, uploading2]);
    const next = reduceAddOptimisticMessage(prev, { channelId: 1, correlationId: "c-1" }, pending);
    expect(next.messagesByChannel.get(1)?.map((m) => m.correlationId)).toEqual([
      null,
      "c-1",
      "u-1",
      "u-2",
    ]);
    expect(next.pendingSends.get("c-1")).toBe(1);
  });

  it("keeps a live message ahead of the trailing uploading rows", () => {
    const prev = state([row({ id: 1 }), pending, uploading]);
    const next = reduceAddMessage(prev, row({ id: 2, user: bob, content: "yo" }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([1, 2, 0, 0]);
    expect(next.messagesByChannel.get(1)?.map((m) => m.status)).toEqual([
      "sent",
      "sent",
      "pending",
      "uploading",
    ]);
  });

  it("is never consumed by an echo with the same text", () => {
    const echo = row({ id: 9, user: me, content: "files", correlationId: null });
    const next = reduceAddMessage(state([uploading]), echo);
    expect(next.messagesByChannel.get(1)?.map((m) => m.status)).toEqual(["sent", "uploading"]);
  });

  it("fails like any optimistic row, found by scanning, and can be removed", () => {
    const prev = state([uploading]);
    const failed = reduceMarkSendFailed(prev, "u-1", "UPLOAD_FAILED");
    expect(failed.messagesByChannel.get(1)?.[0]).toMatchObject({
      status: "failed",
      errorCode: "UPLOAD_FAILED",
    });
    expect(reduceRemoveOptimistic(prev, "u-1").messagesByChannel.get(1)).toEqual([]);
  });
});

describe("reduceMarkSendFailed", () => {
  it("marks a registered send failed and unregisters it", () => {
    const next = reduceMarkSendFailed(state([pending], { pendingSends }), "c-1", "SLOW_MODE");
    expect(next.messagesByChannel.get(1)?.[0]).toMatchObject({
      status: "failed",
      errorCode: "SLOW_MODE",
    });
    expect(next.pendingSends.size).toBe(0);
  });

  it("finds an already-failed row by scanning and relabels it", () => {
    const failed = row({ status: "failed", correlationId: "c-1", errorCode: "OFFLINE" });
    const prev = state([row({ id: 3, correlationId: "other" })]);
    const withOther = {
      ...prev,
      messagesByChannel: new Map([...prev.messagesByChannel, [2, [failed]]]),
    };
    const next = reduceMarkSendFailed(withOther, "c-1", "FORBIDDEN");
    expect(next.messagesByChannel.get(2)?.[0]?.errorCode).toBe("FORBIDDEN");
    expect(next.messagesByChannel.get(1)).toBe(withOther.messagesByChannel.get(1));
  });

  it("returns prev by identity for an unknown correlation", () => {
    const prev = state([pending]);
    expect(reduceMarkSendFailed(prev, "nope", null)).toBe(prev);
  });

  it("returns prev by identity when the registered channel has no rows", () => {
    const prev = { ...INITIAL_STATE, pendingSends };
    expect(reduceMarkSendFailed(prev, "c-1", null)).toBe(prev);
  });
});

describe("reduceRemoveOptimistic", () => {
  it("removes a registered row", () => {
    const next = reduceRemoveOptimistic(state([row({ id: 1 }), pending], { pendingSends }), "c-1");
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([1]);
    expect(next.pendingSends.size).toBe(0);
  });

  it("unregisters even when the registered channel has no rows", () => {
    const next = reduceRemoveOptimistic({ ...INITIAL_STATE, pendingSends }, "c-1");
    expect(next.pendingSends.size).toBe(0);
    expect(next.messagesByChannel.size).toBe(0);
  });

  it("scans for an unregistered (failed) row", () => {
    const failed = row({ status: "failed", correlationId: "c-1" });
    const next = reduceRemoveOptimistic(state([failed, row({ id: 4 })], {}, 7), "c-1");
    expect(next.messagesByChannel.get(7)?.map((m) => m.id)).toEqual([4]);
  });

  it("changes no rows for an unknown correlation", () => {
    const prev = state([pending]);
    const next = reduceRemoveOptimistic(prev, "nope");
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
  });
});

describe("reduceConfirmSend", () => {
  it("stamps the row with its real id and timestamp", () => {
    const failedPending = { ...pending, errorCode: "OFFLINE" };
    const next = reduceConfirmSend(state([failedPending], { pendingSends }), "c-1", 42, "T2");
    expect(next.messagesByChannel.get(1)?.[0]).toMatchObject({
      id: 42,
      timestamp: "T2",
      status: "sent",
      errorCode: null,
    });
    expect(next.pendingSends.size).toBe(0);
  });

  it("finds an unregistered row by its logical client id", () => {
    const retried = row({ status: "failed", correlationId: "old", clientMessageId: "m-1" });
    const next = reduceConfirmSend(state([retried], {}, 5), "new", 42, "T2", "m-1");
    expect(next.messagesByChannel.get(5)?.[0]?.id).toBe(42);
  });

  it("drops the optimistic row when history already holds the message", () => {
    const history = row({ id: 42, content: "sanitized" });
    const next = reduceConfirmSend(state([history, pending], { pendingSends }), "c-1", 42, "T2");
    expect(next.messagesByChannel.get(1)).toEqual([history]);
  });

  it("stamps only the first of two rows sharing a client id", () => {
    const a = row({ status: "pending", correlationId: "c-1", clientMessageId: "m-1" });
    const b = row({ status: "failed", correlationId: "c-2", clientMessageId: "m-1" });
    const prev = state([a, b], {
      pendingSends: new Map([
        ["c-1", 1],
        ["c-2", 1],
      ]),
    });
    const next = reduceConfirmSend(prev, "c-1", 42, "T2", "m-1");
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([42]);
    expect(next.pendingSends.size).toBe(0);
  });

  it("only unregisters when no row matches", () => {
    const prev = { ...state([row({ id: 1 })]), pendingSends: new Map([["c-1", 9]]) };
    const next = reduceConfirmSend(prev, "c-1", 42, "T2");
    expect(next.pendingSends.size).toBe(0);
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
    const unknown = state([row({ id: 1 })]);
    expect(reduceConfirmSend(unknown, "c-1", 42, "T2").messagesByChannel).toBe(
      unknown.messagesByChannel,
    );
  });
});

describe("findSendChannel", () => {
  it("prefers the registry", () => {
    expect(findSendChannel(state([], { pendingSends: new Map([["c-1", 8]]) }), "c-1")).toBe(8);
  });

  it("falls back to an unsent row by correlation or client id", () => {
    expect(findSendChannel(state([pending], {}, 4), "c-1")).toBe(4);
    const byClient = row({ status: "failed", correlationId: "old", clientMessageId: "m-1" });
    expect(findSendChannel(state([byClient], {}, 6), "new", "m-1")).toBe(6);
  });

  it("ignores sent rows and unknown ids", () => {
    const sent = row({ id: 5, correlationId: "c-1", clientMessageId: "m-1" });
    expect(findSendChannel(state([sent]), "c-1", "m-1")).toBeUndefined();
    expect(findSendChannel(state([pending]), "nope")).toBeUndefined();
  });
});

describe("reduceApplyServerMessage", () => {
  const response: MessageResponse = {
    id: 5,
    channel_id: 1,
    user: me,
    content: "edited elsewhere",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: "T3",
    deleted: false,
    timestamp: "T1",
  };

  it("replaces the loaded row in place", () => {
    const next = reduceApplyServerMessage(state([row({ id: 4 }), row({ id: 5 })]), response);
    expect(next.messagesByChannel.get(1)?.map((m) => m.content)).toEqual([
      "hi",
      "edited elsewhere",
    ]);
  });

  it("returns prev by identity when the channel or row is not loaded", () => {
    const empty = { ...INITIAL_STATE };
    expect(reduceApplyServerMessage(empty, response)).toBe(empty);
    const other = state([row({ id: 4 })]);
    expect(reduceApplyServerMessage(other, response)).toBe(other);
    const optimistic = state([row({ id: 0 })]);
    expect(reduceApplyServerMessage(optimistic, { ...response, id: 0 })).toBe(optimistic);
  });
});

describe("reduceAddMessage twin handling", () => {
  it("leaves an optimistic twin alone when the live frame carries no client id", () => {
    const history = row({ id: 5 });
    const twin = row({ status: "pending", correlationId: "c-1", content: "hi" });
    const prev = state([history, twin], { pendingSends });
    const next = reduceAddMessage(prev, row({ id: 5 }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([5, 0]);
    expect(next.pendingSends.has("c-1")).toBe(true);
  });

  it("only consumes the twin whose client id the frame names", () => {
    const history = row({ id: 5 });
    const other = row({ status: "pending", correlationId: "c-2", clientMessageId: "m-2" });
    const twin = row({ status: "pending", correlationId: "c-1", clientMessageId: "m-1" });
    const prev = state([history, other, twin], {
      pendingSends: new Map([
        ["c-1", 1],
        ["c-2", 1],
      ]),
    });
    const next = reduceAddMessage(prev, row({ id: 5, clientMessageId: "m-1" }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.correlationId)).toEqual([null, "c-2"]);
    expect([...next.pendingSends.keys()]).toEqual(["c-2"]);
  });

  it("consumes a twin that has no correlation id without touching the pending map", () => {
    const history = row({ id: 5 });
    const twin = row({ status: "pending", correlationId: null, clientMessageId: "m-1" });
    const prev = state([history, twin], { pendingSends });
    const next = reduceAddMessage(prev, row({ id: 5, clientMessageId: "m-1" }));
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([5]);
    expect(next.pendingSends.has("c-1")).toBe(true);
  });
});

/** Two channels: the same correlation id is on a row in each. */
function twoChannels(rows1: readonly Message[], rows2: readonly Message[], registered?: number) {
  return {
    ...INITIAL_STATE,
    messagesByChannel: new Map([
      [1, rows1],
      [2, rows2],
    ]),
    pendingSends: registered === undefined ? new Map() : new Map([["c-1", registered]]),
  };
}

describe("send bookkeeping across channels", () => {
  const inOne = row({ channelId: 1, status: "pending", correlationId: "c-1", content: "one" });
  const inTwo = row({ channelId: 2, status: "pending", correlationId: "c-1", content: "two" });

  it("marks a failure in the channel the send was registered under", () => {
    const next = reduceMarkSendFailed(twoChannels([inOne], [inTwo], 2), "c-1", "FORBIDDEN");
    expect(next.messagesByChannel.get(2)?.[0]?.status).toBe("failed");
    expect(next.messagesByChannel.get(1)?.[0]?.status).toBe("pending");
  });

  it("finds a failed row among other rows by scanning", () => {
    const failed = row({ status: "failed", correlationId: "c-1", errorCode: "OFFLINE" });
    const prev = state([row({ id: 3, correlationId: "x" }), failed, row({ id: 4 })]);
    const next = reduceMarkSendFailed(prev, "c-1", "FORBIDDEN");
    expect(next.messagesByChannel.get(1)?.map((m) => m.errorCode)).toEqual([
      null,
      "FORBIDDEN",
      null,
    ]);
  });

  it("removes a registered row from its own channel only", () => {
    const next = reduceRemoveOptimistic(twoChannels([inOne], [inTwo], 2), "c-1");
    expect(next.messagesByChannel.get(2)).toEqual([]);
    expect(next.messagesByChannel.get(1)).toEqual([inOne]);
  });

  it("removes a failed row found among other rows by scanning", () => {
    const failed = row({ status: "failed", correlationId: "c-1" });
    const prev = state([row({ id: 3 }), failed, row({ id: 4 })]);
    const next = reduceRemoveOptimistic(prev, "c-1");
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([3, 4]);
  });

  it("confirms a send in the channel it was registered under", () => {
    const next = reduceConfirmSend(twoChannels([inOne], [inTwo], 2), "c-1", 42, "T2");
    expect(next.messagesByChannel.get(2)?.[0]?.id).toBe(42);
    expect(next.messagesByChannel.get(1)?.[0]?.status).toBe("pending");
  });

  it("reports the registered channel before looking at any rows", () => {
    expect(findSendChannel(twoChannels([inOne], [inTwo], 2), "c-1")).toBe(2);
    expect(findSendChannel(twoChannels([inOne], [inTwo]), "c-1")).toBe(1);
  });
});

describe("matching an unregistered send", () => {
  const delivered = row({ id: 5, status: "sent", correlationId: "c-1", clientMessageId: "m-1" });
  const unsent = row({ status: "pending", correlationId: "c-9", clientMessageId: "m-9" });

  it("a confirmed row that kept its correlation id is not matched again", () => {
    const prev = twoChannels([delivered], [unsent]);
    const next = reduceConfirmSend(prev, "c-1", 77, "T9", "m-1");
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
    expect(findSendChannel(prev, "c-1", "m-1")).toBeUndefined();
  });

  it("another send's row is never taken for this one", () => {
    const prev = state([unsent]);
    const next = reduceConfirmSend(prev, "c-1", 77, "T9");
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
    expect(findSendChannel(prev, "c-1")).toBeUndefined();
  });

  it("a different client id does not match when the correlation id differs", () => {
    const prev = state([unsent]);
    const next = reduceConfirmSend(prev, "c-1", 77, "T9", "m-1");
    expect(next.messagesByChannel).toBe(prev.messagesByChannel);
    expect(findSendChannel(prev, "c-1", "m-1")).toBeUndefined();
  });

  it("a row without a client id does not match a send that has none either", () => {
    const bare = row({ status: "pending", correlationId: "c-9" });
    const prev = state([bare]);
    expect(reduceConfirmSend(prev, "c-1", 77, "T9").messagesByChannel).toBe(prev.messagesByChannel);
    expect(findSendChannel(prev, "c-1")).toBeUndefined();
  });

  it("a registered send does not rewrite a delivered row that kept its correlation id", () => {
    const kept = row({ id: 5, status: "sent", correlationId: "c-1" });
    const next = reduceConfirmSend(state([kept], { pendingSends }), "c-1", 42, "T2");
    expect(next.messagesByChannel.get(1)).toEqual([kept]);
    expect(next.pendingSends.size).toBe(0);
  });

  it("an ack naming one client id leaves the other unsent rows alone", () => {
    const mine = row({ status: "pending", correlationId: "c-1", clientMessageId: "m-1" });
    const other = row({ status: "pending", correlationId: "c-9", clientMessageId: "m-9" });
    const prev = state([mine, other], {
      pendingSends: new Map([
        ["c-1", 1],
        ["c-9", 1],
      ]),
    });
    const next = reduceConfirmSend(prev, "c-1", 42, "T2", "m-1");
    expect(next.messagesByChannel.get(1)?.map((m) => [m.id, m.correlationId])).toEqual([
      [42, "c-1"],
      [0, "c-9"],
    ]);
    expect([...next.pendingSends.keys()]).toEqual(["c-9"]);
  });

  it("stamps only the matching row among several unsent ones", () => {
    const a = row({ status: "pending", correlationId: "c-1", content: "a" });
    const b = row({ status: "pending", correlationId: "c-2", content: "b" });
    const prev = state([row({ id: 3 }), a, b], {
      pendingSends: new Map([
        ["c-1", 1],
        ["c-2", 1],
      ]),
    });
    const next = reduceConfirmSend(prev, "c-1", 42, "T2");
    expect(next.messagesByChannel.get(1)?.map((m) => [m.id, m.status])).toEqual([
      [3, "sent"],
      [42, "sent"],
      [0, "pending"],
    ]);
    expect([...next.pendingSends.keys()]).toEqual(["c-2"]);
  });

  it("an unrelated delivered row does not make the ack a duplicate", () => {
    const prev = state([row({ id: 3 }), pending], { pendingSends });
    const next = reduceConfirmSend(prev, "c-1", 42, "T2");
    expect(next.messagesByChannel.get(1)?.map((m) => m.id)).toEqual([3, 42]);
  });

  it("a delivered row with the acked id is the only copy kept, whatever else is unsent", () => {
    const history = row({ id: 42, content: "sanitized" });
    const prev = state([history, pending, row({ status: "pending", correlationId: "c-2" })], {
      pendingSends: new Map([
        ["c-1", 1],
        ["c-2", 1],
      ]),
    });
    const next = reduceConfirmSend(prev, "c-1", 42, "T2");
    expect(next.messagesByChannel.get(1)?.map((m) => [m.id, m.correlationId])).toEqual([
      [42, null],
      [0, "c-2"],
    ]);
  });

  it("finds an unsent row in a list that also holds delivered rows", () => {
    expect(findSendChannel(state([row({ id: 3 }), pending, row({ id: 4 })], {}, 8), "c-1")).toBe(8);
    const prev = state([row({ id: 3 }), pending, row({ id: 4 })], {}, 8);
    const next = reduceConfirmSend(prev, "c-1", 42, "T2");
    expect(next.messagesByChannel.get(8)?.map((m) => m.id)).toEqual([3, 42, 4]);
  });
});
