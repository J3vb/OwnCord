import { afterEach, describe, expect, it } from "vitest";
import {
  adoptReadyThreads,
  applyFollowUpdate,
  applyFollowedReadState,
  clearFollowedCounts,
  isFollowed,
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
import { runSessionResets } from "../../src/lib/net/sessionRegistry";
import type { ReadyThread } from "../../src/lib/types";
import { makeThread } from "../helpers/thread-fixtures";

afterEach(() => resetThreadsStore());

function entry(id: number, over: Partial<ReadyThread> = {}, parent = 1): ReadyThread {
  return {
    thread: makeThread({ id, parent_id: parent, name: `t${id}`, starter_message_id: id }),
    last_message_id: 50,
    last_read_message_id: 40,
    unread_count: 3,
    mention_count: 1,
    ...over,
  };
}

const rows = (parent = 1) => followedThreadsStore.getState().byParent.get(parent) ?? [];

describe("threadsStore follow map", () => {
  it("adopts ready.threads with counts and publishes the sidebar rows", () => {
    adoptReadyThreads([entry(91), entry(92, { unread_count: 0, mention_count: 0 })]);
    expect(threadsStore.getState().followed.get(91)).toEqual({
      unread: 3,
      mentions: 1,
      lastMessageId: 50,
      lastReadId: 40,
    });
    expect(
      rows()
        .map((r) => r.id)
        .toSorted(),
    ).toEqual([91, 92]);
    expect(rows().find((r) => r.id === 91)).toMatchObject({ unread: 3, mentions: 1, name: "t91" });
  });

  it("treats every ready as the whole set", () => {
    adoptReadyThreads([entry(91), entry(92)]);
    adoptReadyThreads([entry(92)]);
    expect(isFollowed(91)).toBe(false);
    expect(isFollowed(92)).toBe(true);
    adoptReadyThreads([]);
    expect(rows()).toEqual([]);
  });

  it("sorts a parent's rows by last activity, newest first", () => {
    adoptReadyThreads([
      { ...entry(91), thread: makeThread({ id: 91, last_message_at: "2026-10-20T00:00:00Z" }) },
      { ...entry(92), thread: makeThread({ id: 92, last_message_at: "2026-10-22T00:00:00Z" }) },
      { ...entry(93), thread: makeThread({ id: 93, last_message_at: "2026-10-21T00:00:00Z" }) },
    ]);
    expect(rows().map((r) => r.id)).toEqual([92, 93, 91]);
  });

  it("follows on thread_follow_update true and unfollows on false", () => {
    applyFollowUpdate(91, true, makeThread({ id: 91 }));
    expect(isFollowed(91)).toBe(true);
    expect(rows()).toHaveLength(1);
    applyFollowUpdate(91, false);
    expect(isFollowed(91)).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("keeps the counts of a thread that is followed again", () => {
    adoptReadyThreads([entry(91)]);
    applyFollowUpdate(91, true, makeThread({ id: 91, name: "renamed" }));
    expect(threadsStore.getState().followed.get(91)?.unread).toBe(3);
    expect(rows()[0]?.name).toBe("renamed");
  });

  it("ignores a follow it has no thread state for", () => {
    applyFollowUpdate(77, true);
    expect(isFollowed(77)).toBe(false);
  });

  it("drops a deleted thread's row, and a late following:true cannot bring it back", () => {
    adoptReadyThreads([entry(91)]);
    removeThread(91);
    expect(isFollowed(91)).toBe(false);
    expect(rows()).toEqual([]);
    applyFollowUpdate(91, true, makeThread({ id: 91 }));
    expect(isFollowed(91)).toBe(false);
    expect(rows()).toEqual([]);
    adoptReadyThreads([entry(91)]);
    expect(isFollowed(91)).toBe(false);
  });

  it("hides an archived thread's row but keeps the follow, and the row returns on reopen", () => {
    adoptReadyThreads([entry(91)]);
    applyFollowUpdate(91, true, makeThread({ id: 91, archived: true }));
    expect(isFollowed(91)).toBe(true);
    expect(rows()).toEqual([]);
    applyFollowUpdate(91, true, makeThread({ id: 91, archived: false }));
    expect(rows()).toHaveLength(1);
  });

  it("counts a newer activity hint once and ignores one at or below the watermark", () => {
    adoptReadyThreads([entry(91, { unread_count: 0, mention_count: 0 })]);
    expect(noteFollowedActivity(91, 50)).toBe(false);
    expect(noteFollowedActivity(91, 51)).toBe(true);
    expect(noteFollowedActivity(91, 51)).toBe(false);
    expect(threadsStore.getState().followed.get(91)?.unread).toBe(1);
    expect(noteFollowedActivity(999, 5)).toBe(false);
  });

  it("takes the mention total as given and reports the previous one", () => {
    adoptReadyThreads([entry(91, { mention_count: 1 })]);
    expect(setFollowedMentions(91, 4)).toBe(1);
    expect(rows()[0]?.mentions).toBe(4);
    expect(setFollowedMentions(5, 2)).toBeUndefined();
  });

  it("reads a thread when its panel opens and ignores hints while it is open", () => {
    adoptReadyThreads([entry(91)]);
    setFocusedThread(91);
    expect(threadsStore.getState().followed.get(91)).toMatchObject({ unread: 0, mentions: 0 });
    expect(noteFollowedActivity(91, 99)).toBe(false);
    expect(setFollowedMentions(91, 3)).toBeUndefined();
    expect(followedThreadsStore.getState().focusedId).toBe(91);
  });

  it("clears counts on mark as read and follows a read_state pointer", () => {
    adoptReadyThreads([entry(91)]);
    clearFollowedCounts(91);
    expect(threadsStore.getState().followed.get(91)).toMatchObject({ unread: 0, mentions: 0 });
    applyFollowedReadState(91, { lastReadId: 60, unread: 2, mentions: 1 });
    expect(threadsStore.getState().followed.get(91)).toMatchObject({
      lastReadId: 60,
      unread: 2,
      mentions: 1,
    });
  });

  it("empties the map and the published rows on a session reset", () => {
    adoptReadyThreads([entry(91)]);
    runSessionResets("server_switch");
    expect(threadsStore.getState().followed.size).toBe(0);
    expect(followedThreadsStore.getState().byParent.size).toBe(0);
  });

  it("a message in the open thread is seen, so a coalesced hint after closing does not count it", () => {
    adoptReadyThreads([entry(91, { unread_count: 0, mention_count: 0 })]);
    setFocusedThread(91);
    noteOpenThreadMessage(91, 60);
    setFocusedThread(null);
    expect(noteFollowedActivity(91, 60)).toBe(false);
    expect(noteFollowedActivity(91, 61)).toBe(true);
    // Not followed, or not the open thread: nothing recorded.
    noteOpenThreadMessage(999, 5);
    noteOpenThreadMessage(91, 70);
    expect(threadsStore.getState().followed.get(91)?.lastMessageId).toBe(61);
  });

  it("republishes the sidebar view only when a row changed", () => {
    adoptReadyThreads([entry(91), entry(92)]);
    const before = followedThreadsStore.getState();
    // Same rows again (a history page re-adopting the same thread).
    adoptReadyThreads([entry(91), entry(92)]);
    upsertThread(makeThread({ id: 91, parent_id: 1, name: "t91", starter_message_id: 91 }));
    expect(followedThreadsStore.getState()).toBe(before);
    adoptReadyThreads([entry(91, { unread_count: 9 }), entry(92)]);
    expect(followedThreadsStore.getState()).not.toBe(before);
  });
});
