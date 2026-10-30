import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptThreadSnapshots,
  authorityChannelId,
  getThread,
  isReadSurface,
  removeThread,
  resetThreadsStore,
  setFocusedThread,
  threadOfMessage,
  threadsStore,
  upsertThread,
} from "../../src/stores/threads.store";
import { adoptStarterThreads, withThreadsStore } from "../../src/stores/threadsLoader";
import { runSessionResets } from "../../src/lib/net/sessionRegistry";
import { makeThread } from "../helpers/thread-fixtures";

afterEach(() => {
  resetThreadsStore();
});

describe("threadsStore", () => {
  it("records a created thread by id and by starter message", () => {
    upsertThread(makeThread());
    const s = threadsStore.getState();
    expect(s.byId.get(91)?.name).toBe("Release plan");
    expect(s.byStarter.get(1)).toBe(91);
  });

  it("replaces the whole state on thread_changed", () => {
    upsertThread(makeThread());
    upsertThread(makeThread({ name: "Renamed", message_count: 12, archived: true }));
    const t = getThread(91);
    expect(t?.name).toBe("Renamed");
    expect(t?.message_count).toBe(12);
    expect(t?.archived).toBe(true);
    expect(threadsStore.getState().byId.size).toBe(1);
  });

  it("forgets a deleted thread and closes the panel on it", () => {
    upsertThread(makeThread());
    setFocusedThread(91);
    removeThread(91);
    const s = threadsStore.getState();
    expect(s.byId.has(91)).toBe(false);
    expect(s.byStarter.has(1)).toBe(false);
    expect(s.focusedThreadId).toBeNull();
  });

  it("ignores a thread_changed that arrives after its thread_deleted", () => {
    upsertThread(makeThread());
    removeThread(91);
    upsertThread(makeThread({ message_count: 8 }));
    expect(getThread(91)).toBeUndefined();
    expect(threadsStore.getState().byStarter.has(1)).toBe(false);
  });

  it("ignores a late change for a thread it never saw before the delete", () => {
    removeThread(55);
    upsertThread(makeThread({ id: 55, starter_message_id: 3 }));
    expect(getThread(55)).toBeUndefined();
  });

  it("is emptied by the session reset, deleted ids and focus included", () => {
    upsertThread(makeThread());
    setFocusedThread(91);
    removeThread(92);
    runSessionResets("server_switch");
    const s = threadsStore.getState();
    expect(s.byId.size).toBe(0);
    expect(s.focusedThreadId).toBeNull();
    expect(s.deleted.size).toBe(0);
    // A thread with a once-deleted id is welcome again on the next server.
    upsertThread(makeThread({ id: 92 }));
    expect(getThread(92)).toBeDefined();
  });

  it("adopts a fetched starter row's thread when it shows newer activity", async () => {
    upsertThread(makeThread({ message_count: 2, last_message_at: "2026-10-21T09:00:00Z" }));
    adoptStarterThreads([
      { thread: makeThread({ message_count: 9, last_message_at: "2026-10-21T10:00:00Z" }) },
      {},
    ]);
    await vi.waitFor(() => expect(getThread(91)?.message_count).toBe(9));
  });

  it("never lets a REST snapshot unlock, rename or un-archive what a live frame set", async () => {
    upsertThread(makeThread({ locked: true, name: "Live name", archived: true }));
    adoptStarterThreads([{ thread: makeThread({ locked: false, name: "Old", archived: false }) }]);
    adoptThreadSnapshots([makeThread({ locked: false, name: "Old", archived: false })]);
    await vi.waitFor(() => expect(withThreadsStoreRan()).toBe(true));
    expect(getThread(91)).toMatchObject({ locked: true, name: "Live name", archived: true });
  });

  it("fills in a thread it has not seen from a snapshot", () => {
    adoptThreadSnapshots([makeThread({ id: 5, starter_message_id: 3 })]);
    expect(getThread(5)).toBeDefined();
    expect(threadsStore.getState().byStarter.get(3)).toBe(5);
  });
});

describe("threadOfMessage", () => {
  it("prefers the store's live state over the row's snapshot", () => {
    const snapshot = makeThread({ message_count: 1 });
    upsertThread(makeThread({ message_count: 5 }));
    expect(threadOfMessage({ id: 1, thread: snapshot })?.message_count).toBe(5);
  });

  it("falls back to the snapshot when the store has not heard of it", () => {
    expect(threadOfMessage({ id: 1, thread: makeThread() })?.id).toBe(91);
  });

  it("finds a thread created this session by its starter message", () => {
    upsertThread(makeThread());
    expect(threadOfMessage({ id: 1 })?.id).toBe(91);
    expect(threadOfMessage({ id: 2 })).toBeUndefined();
  });

  it("is undefined once the thread was deleted, even with a snapshot on the row", () => {
    removeThread(91);
    expect(threadOfMessage({ id: 1, thread: makeThread() })).toBeUndefined();
  });
});

describe("channel-like lookups", () => {
  it("resolves a thread to its parent and leaves other ids alone", () => {
    upsertThread(makeThread());
    expect(authorityChannelId(91)).toBe(1);
    expect(authorityChannelId(1)).toBe(1);
  });

  it("treats the active channel and the focused thread as read surfaces", () => {
    expect(isReadSurface(5, 5)).toBe(true);
    expect(isReadSurface(91, 5)).toBe(false);
    setFocusedThread(91);
    expect(isReadSurface(91, 5)).toBe(true);
    expect(isReadSurface(92, 5)).toBe(false);
  });
});

function withThreadsStoreRan(): boolean {
  let ran = false;
  withThreadsStore(() => {
    ran = true;
  });
  return ran;
}

describe("threadsLoader", () => {
  it("runs queued work in call order once the store has loaded, then synchronously", async () => {
    const seen: string[] = [];
    withThreadsStore(() => seen.push("first"));
    withThreadsStore(() => seen.push("second"));
    await vi.waitFor(() => expect(seen).toEqual(["first", "second"]));
    withThreadsStore(() => seen.push("third"));
    expect(seen).toEqual(["first", "second", "third"]);
  });

  it("loads nothing for rows that carry no thread", () => {
    adoptStarterThreads([{}, {}]);
    expect(threadsStore.getState().byId.size).toBe(0);
  });
});
