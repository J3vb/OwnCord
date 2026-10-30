import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markChannelRead,
  markChannelReadSeen,
  noteMessageSeen,
  resetReadPointerState,
  setMarkReadSender,
} from "../../src/lib/readState";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../src/lib/net/serverCapabilities";
import { resetChannelsStore } from "../../src/stores/channels.store";
import {
  adoptReadyThreads,
  applyFollowedReadState,
  resetThreadsStore,
  upsertThread,
} from "../../src/stores/threads.store";
import { makeThread } from "../helpers/thread-fixtures";

describe("mark_read with a thread id", () => {
  const sender = vi.fn();
  beforeEach(() => {
    resetChannelsStore();
    resetThreadsStore();
    resetReadPointerState();
    sender.mockClear();
    setMarkReadSender(sender);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    upsertThread(makeThread({ id: 91, parent_id: 1 }));
  });
  afterEach(() => {
    setMarkReadSender(null);
    resetServerCapabilities();
    resetThreadsStore();
    vi.restoreAllMocks();
  });

  it("Mark as Read on a known thread sends mark_read with the thread id", () => {
    markChannelRead(91);
    expect(sender).toHaveBeenCalledWith(91);
  });

  it("does not send for an id that is neither a channel nor a known thread", () => {
    markChannelRead(555);
    expect(sender).not.toHaveBeenCalled();
  });

  it("the panel's read marking sends the newest seen message once", () => {
    applyReadyCapabilities({ read_pointer: true, threads: true });
    noteMessageSeen(91, 120);
    markChannelReadSeen(91);
    markChannelReadSeen(91);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(91, 120);
  });

  it("seeds the pointer from ready.threads and follows a read_state that moved it back", () => {
    applyReadyCapabilities({ read_pointer: true, threads: true });
    adoptReadyThreads([
      {
        thread: makeThread({ id: 91, parent_id: 1 }),
        last_message_id: 200,
        last_read_message_id: 200,
        unread_count: 0,
        mention_count: 0,
      },
    ]);
    // Already read up to 200: seeing 150 is nothing to send.
    noteMessageSeen(91, 150);
    markChannelReadSeen(91);
    expect(sender).not.toHaveBeenCalled();
    // Another device marked it unread from 100: a later local read must send.
    applyFollowedReadState(91, { lastReadId: 100, unread: 3, mentions: 0 });
    markChannelReadSeen(91);
    expect(sender).toHaveBeenCalledWith(91, 150);
  });
});
