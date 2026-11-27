import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchReplyTarget } from "../../src/features/messaging/composer/replyTargetWatch";
import { lastOwnEditable } from "../../src/features/messaging/lastOwnEditable";
import { deleteMessage, messagesStore, resetMessagesStore } from "@stores/messages.store";
import { ME, makeMessage } from "../helpers/message-actions-fixtures";

const CHANNEL = 7;

function seed(ids: number[]): void {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map(prev.messagesByChannel).set(
      CHANNEL,
      ids.map((id) => makeMessage({ id, channelId: CHANNEL })),
    ),
  }));
}

/** A reply bar that holds `target` until cleared, like the composer's. */
function fakeBar(target: number | null) {
  let replyTo = target;
  const clearReply = vi.fn(() => {
    replyTo = null;
  });
  return {
    clearReply,
    peekDraft: () => ({
      content: "",
      replyTo: replyTo === null ? null : { messageId: replyTo, username: "alice" },
    }),
  };
}

beforeEach(() => {
  resetMessagesStore();
  seed([10, 11]);
});
afterEach(() => resetMessagesStore());

describe("watchReplyTarget", () => {
  it("clears the bar when the replied-to message is deleted", () => {
    const bar = fakeBar(10);
    const stop = watchReplyTarget(bar, CHANNEL);
    deleteMessage({ message_id: 10, channel_id: CHANNEL });
    messagesStore.flush();
    expect(bar.clearReply).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores another message's deletion and a bar with no reply", () => {
    const withReply = fakeBar(10);
    const noReply = fakeBar(null);
    const stops = [watchReplyTarget(withReply, CHANNEL), watchReplyTarget(noReply, CHANNEL)];
    deleteMessage({ message_id: 11, channel_id: CHANNEL });
    messagesStore.flush();
    expect(withReply.clearReply).not.toHaveBeenCalled();
    expect(noReply.clearReply).not.toHaveBeenCalled();
    stops.forEach((stop) => stop());
  });

  it("does not throw when the send already cleared the bar before the delete lands", () => {
    const bar = fakeBar(10);
    const stop = watchReplyTarget(bar, CHANNEL);
    // The send built its message from the reply, then cleared the bar.
    bar.clearReply();
    deleteMessage({ message_id: 10, channel_id: CHANNEL });
    expect(() => messagesStore.flush()).not.toThrow();
    expect(bar.clearReply).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops watching after the unsubscribe", () => {
    const bar = fakeBar(10);
    watchReplyTarget(bar, CHANNEL)();
    deleteMessage({ message_id: 10, channel_id: CHANNEL });
    messagesStore.flush();
    expect(bar.clearReply).not.toHaveBeenCalled();
  });
});

describe("lastOwnEditable", () => {
  const mine = (id: number, over = {}) =>
    makeMessage({ id, user: { id: ME, username: "me", avatar: null }, ...over });

  it("picks the newest own sent text message", () => {
    const rows = [mine(1), mine(2), makeMessage({ id: 3 })];
    expect(lastOwnEditable(rows, ME)?.id).toBe(2);
  });

  it("skips deleted, unsent and sticker rows", () => {
    const rows = [
      mine(1),
      mine(2, { deleted: true }),
      mine(0, { status: "pending" }),
      mine(4, { sticker: { id: 1, name: "s", url: "/s" } }),
    ];
    expect(lastOwnEditable(rows, ME)?.id).toBe(1);
    expect(lastOwnEditable([], ME)).toBeUndefined();
  });
});
