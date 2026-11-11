import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptThreadSnapshots,
  getThread,
  removeThread,
  resetThreadsStore,
  threadOfMessage,
  threadsStore,
  upsertThread,
} from "../../src/stores/threads.store";
import {
  adoptStarterThreads,
  loadedThreadsStore,
  resumeThreadFocus,
  withThreadsStore,
} from "../../src/stores/threadsLoader";
import {
  channelsStore,
  resetChannelsStore,
  setActiveChannel,
} from "../../src/stores/channels.store";
import { makeThread } from "../helpers/thread-fixtures";

const OLD = { locked: true, name: "Old", archived: false };
const FRESH = { locked: false, name: "New", archived: true };

beforeEach(() => {
  setActiveChannel(1);
  channelsStore.flush();
});

afterEach(() => {
  resetThreadsStore();
  resetChannelsStore();
});

describe("a snapshot of a thread no live frame set", () => {
  it("replaces an earlier snapshot even with the same last activity", () => {
    adoptThreadSnapshots([makeThread(OLD)]);
    adoptThreadSnapshots([makeThread(FRESH)]);
    expect(getThread(91)).toMatchObject(FRESH);
    expect(threadOfMessage({ id: 1, thread: makeThread(FRESH) })).toMatchObject(FRESH);
  });

  it("does not undo a live frame while the parent is still the open channel", () => {
    upsertThread(makeThread(OLD));
    adoptThreadSnapshots([makeThread(FRESH)]);
    expect(getThread(91)).toMatchObject(OLD);
  });

  it("keeps a live frame over a page still on its way when the parent is left", () => {
    upsertThread(makeThread(OLD));
    setActiveChannel(2);
    channelsStore.flush();
    adoptThreadSnapshots([makeThread(FRESH)]);
    expect(getThread(91)).toMatchObject(OLD);
  });

  it("replaces a live frame once its parent is opened again", () => {
    upsertThread(makeThread(OLD));
    setActiveChannel(2);
    channelsStore.flush();
    setActiveChannel(1);
    channelsStore.flush();
    adoptThreadSnapshots([makeThread(FRESH)]);
    expect(getThread(91)).toMatchObject(FRESH);
  });

  it("only forgets the live frames of the parent that is opened", () => {
    const other = { id: 92, parent_id: 2, starter_message_id: 5 };
    upsertThread(makeThread({ ...OLD, ...other }));
    upsertThread(makeThread(OLD));
    setActiveChannel(2);
    channelsStore.flush();
    adoptThreadSnapshots([makeThread({ ...FRESH, ...other }), makeThread(FRESH)]);
    expect(getThread(92)).toMatchObject(FRESH);
    expect(getThread(91)).toMatchObject(OLD);
  });

  it("forgets the mark of a deleted thread", () => {
    upsertThread(makeThread(OLD));
    removeThread(91);
    expect(threadsStore.getState().live.has(91)).toBe(false);
  });

  it("replaces a live frame after an authenticated reconnect", async () => {
    upsertThread(makeThread(OLD));
    withThreadsStore(() => undefined);
    await vi.waitFor(() => expect(loadedThreadsStore()).not.toBeNull());
    resumeThreadFocus({ send: vi.fn() }, undefined);
    adoptThreadSnapshots([makeThread(FRESH)]);
    expect(getThread(91)).toMatchObject(FRESH);
  });
});

describe("a starter row refetched without a thread", () => {
  it("drops the thread a snapshot taught, so no chip and Create thread is offered", async () => {
    adoptThreadSnapshots([makeThread()]);
    expect(threadOfMessage({ id: 1 })?.id).toBe(91);
    adoptStarterThreads([{ id: 1 }, { id: 2 }]);
    await vi.waitFor(() => expect(threadOfMessage({ id: 1 })).toBeUndefined());
    expect(getThread(91)).toBeUndefined();
    expect(threadsStore.getState().byStarter.has(1)).toBe(false);
  });

  it("keeps the thread of a deleted starter row, which never carries one", async () => {
    adoptThreadSnapshots([makeThread()]);
    adoptStarterThreads([{ id: 1, deleted: true }, { id: 2 }]);
    await vi.waitFor(() => expect(loadedThreadsStore()).not.toBeNull());
    expect(getThread(91)?.id).toBe(91);
  });

  it("keeps a thread a live frame set while its parent is open", async () => {
    upsertThread(makeThread());
    adoptStarterThreads([{ id: 1 }]);
    await vi.waitFor(() => expect(loadedThreadsStore()).not.toBeNull());
    expect(threadOfMessage({ id: 1 })?.id).toBe(91);
  });
});
