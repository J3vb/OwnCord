import { afterEach, describe, expect, it } from "vitest";
import {
  adoptReadyThreads,
  applyFollowUpdate,
  applyFollowedReadState,
  clearFollowedCounts,
  noteFollowedActivity,
  noteOpenThreadMessage,
  removeThread,
  resetThreadsStore,
  setFocusedThread,
  setFollowedMentions,
  threadsStore,
  upsertThread,
} from "../../src/stores/threads.store";
import { followedThreadsStore } from "../../src/stores/followedThreads.store";
import type { ReadyThread } from "../../src/lib/types";
import { makeThread } from "../helpers/thread-fixtures";

afterEach(() => resetThreadsStore());

function entry(id: number, over: Partial<ReadyThread> = {}): ReadyThread {
  return {
    thread: makeThread({ id, parent_id: 1, name: `t${id}`, starter_message_id: id }),
    last_message_id: 50,
    last_read_message_id: 40,
    unread_count: 3,
    mention_count: 1,
    ...over,
  };
}

const followed = (id: number) => threadsStore.getState().followed.get(id);
const rowIds = () => (followedThreadsStore.getState().byParent.get(1) ?? []).map((r) => r.id);

describe("sidebar row order", () => {
  it("breaks a tie in last activity by putting the higher thread id first", () => {
    const same = "2026-10-21T09:30:00Z";
    const threads = [91, 92, 93].map((id) =>
      entry(id, { thread: makeThread({ id, starter_message_id: id, last_message_at: same }) }),
    );
    adoptReadyThreads(threads);
    expect(rowIds()).toEqual([93, 92, 91]);
    adoptReadyThreads(threads.toReversed());
    expect(rowIds()).toEqual([93, 92, 91]);
  });

  it("puts a thread with no activity time after one with activity", () => {
    adoptReadyThreads([
      entry(95, { thread: makeThread({ id: 95, starter_message_id: 95, last_message_at: null }) }),
      entry(91),
    ]);
    expect(rowIds()).toEqual([91, 95]);
  });
});

describe("thread records", () => {
  it("keeps the starter index as it was when a change leaves the starter alone", () => {
    upsertThread(makeThread());
    const index = threadsStore.getState().byStarter;
    upsertThread(makeThread({ name: "Renamed" }));
    expect(threadsStore.getState().byStarter).toBe(index);
    expect(threadsStore.getState().byId.get(91)?.name).toBe("Renamed");
  });

  it("keeps the panel on another thread when a different one is deleted", () => {
    upsertThread(makeThread());
    upsertThread(makeThread({ id: 92, starter_message_id: 2 }));
    setFocusedThread(92);
    removeThread(91);
    expect(threadsStore.getState().focusedThreadId).toBe(92);
    removeThread(92);
    expect(threadsStore.getState().focusedThreadId).toBeNull();
  });

  it("leaves the state alone when the panel is opened on the thread it already shows", () => {
    setFocusedThread(91);
    const state = threadsStore.getState();
    setFocusedThread(91);
    expect(threadsStore.getState()).toBe(state);
  });
});

describe("read counts", () => {
  it("clears a count that has only unread, only mentions, or both, and leaves a clear thread alone", () => {
    adoptReadyThreads([
      entry(91, { unread_count: 2, mention_count: 0 }),
      entry(92, { unread_count: 0, mention_count: 2 }),
      entry(93, { unread_count: 0, mention_count: 0 }),
    ]);
    clearFollowedCounts(91);
    expect(followed(91)).toMatchObject({ unread: 0, mentions: 0, lastReadId: 50 });
    clearFollowedCounts(92);
    expect(followed(92)).toMatchObject({ unread: 0, mentions: 0, lastReadId: 50 });

    const state = threadsStore.getState();
    clearFollowedCounts(93);
    expect(threadsStore.getState()).toBe(state);
    clearFollowedCounts(404);
    expect(threadsStore.getState()).toBe(state);
  });

  it("reads the thread the panel already shows when the follow set arrives", () => {
    setFocusedThread(91);
    adoptReadyThreads([entry(91), entry(92)]);
    expect(followed(91)).toMatchObject({ unread: 0, mentions: 0 });
    expect(followed(92)).toMatchObject({ unread: 3, mentions: 1 });
  });

  it("keeps the open thread at zero when a read_state frame names counts for it", () => {
    adoptReadyThreads([entry(91)]);
    setFocusedThread(91);
    applyFollowedReadState(91, { lastReadId: 60, unread: 2, mentions: 1 });
    expect(followed(91)).toMatchObject({ lastReadId: 60, unread: 0, mentions: 0 });
  });

  it("leaves the state alone for an unfollow of a thread that was not followed", () => {
    adoptReadyThreads([entry(91)]);
    const state = threadsStore.getState();
    applyFollowUpdate(404, false);
    expect(threadsStore.getState()).toBe(state);
    applyFollowUpdate(91, false);
    expect(followed(91)).toBeUndefined();
  });
});

describe("activity hints", () => {
  it("ignores a hint at or below the read pointer even when it is past the last counted message", () => {
    adoptReadyThreads([
      entry(91, {
        last_message_id: 50,
        last_read_message_id: 60,
        unread_count: 0,
        mention_count: 0,
      }),
    ]);
    expect(noteFollowedActivity(91, 55)).toBe(false);
    expect(noteFollowedActivity(91, 60)).toBe(false);
    expect(noteFollowedActivity(91, 61)).toBe(true);
    expect(followed(91)).toMatchObject({ unread: 1, lastMessageId: 61 });
  });

  it("keeps the state when a mention total repeats", () => {
    adoptReadyThreads([entry(91, { mention_count: 2 })]);
    const state = threadsStore.getState();
    expect(setFollowedMentions(91, 2)).toBe(2);
    expect(threadsStore.getState()).toBe(state);
    expect(setFollowedMentions(91, 0)).toBe(2);
    expect(followed(91)?.mentions).toBe(0);
  });
});

function open(over: Partial<ReadyThread> = {}): void {
  adoptReadyThreads([entry(91, { unread_count: 0, mention_count: 0, ...over })]);
  setFocusedThread(91);
}

describe("messages landing in the open thread", () => {
  it("moves the pointers forward to the newest message and never backwards", () => {
    open();
    noteOpenThreadMessage(91, 60);
    expect(followed(91)).toMatchObject({ lastMessageId: 60, lastReadId: 60 });
    noteOpenThreadMessage(91, 55);
    expect(followed(91)).toMatchObject({ lastMessageId: 60, lastReadId: 60 });
  });

  it("advances the read pointer for a message already counted but not yet read", () => {
    open({ last_message_id: 50, last_read_message_id: 40 });
    noteOpenThreadMessage(91, 45);
    expect(followed(91)).toMatchObject({ lastMessageId: 50, lastReadId: 45 });
  });

  it("advances the counted pointer for a message past it even when the read pointer is further ahead", () => {
    open({ last_message_id: 50, last_read_message_id: 60 });
    noteOpenThreadMessage(91, 55);
    expect(followed(91)).toMatchObject({ lastMessageId: 55, lastReadId: 60 });
  });

  it("changes nothing for a message at or below both pointers", () => {
    open({ last_message_id: 50, last_read_message_id: 40 });
    const state = threadsStore.getState();
    noteOpenThreadMessage(91, 40);
    expect(threadsStore.getState()).toBe(state);
    noteOpenThreadMessage(91, 30);
    expect(threadsStore.getState()).toBe(state);
  });

  it("changes nothing for a message equal to both pointers", () => {
    open({ last_message_id: 50, last_read_message_id: 50 });
    const state = threadsStore.getState();
    noteOpenThreadMessage(91, 50);
    expect(threadsStore.getState()).toBe(state);
  });
});
