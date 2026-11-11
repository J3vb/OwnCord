import { describe, expect, it, vi } from "vitest";
import { listSessionResets, runSessionResets } from "../../src/lib/net/sessionRegistry";
import { makeThread } from "../helpers/thread-fixtures";

// Everything here is one story told in order, on a loader module that is
// imported inside the test body so its first load is observable.
describe("threadsLoader lifecycle", () => {
  it("loads only on need, drops work queued for a previous server, then serves from the loaded store", async () => {
    const loader = await import("../../src/stores/threadsLoader");
    expect(loader.threadsStoreInUse()).toBe(false);
    expect(loader.loadedThreadsStore()).toBeNull();
    expect(listSessionResets()).toContain("threads:loader");

    // Rows without a thread never ask for the store.
    loader.adoptStarterThreads([{}, {}]);
    expect(loader.threadsStoreInUse()).toBe(false);

    // Work queued for the previous server must not run against the next one,
    // but the load already under way still counts as the store being in use.
    const ran: string[] = [];
    loader.withThreadsStore(() => ran.push("previous server"));
    expect(loader.threadsStoreInUse()).toBe(true);
    runSessionResets("server_switch");
    expect(loader.threadsStoreInUse()).toBe(true);

    // A frame still waiting for the store, then a reconnect: the reconnect's
    // clear runs behind the frame, so its mark does not outlive the reconnect.
    loader.withThreadsStore((m) => m.upsertThread(makeThread({ id: 5, starter_message_id: 2 })));
    loader.resumeThreadFocus({ send: vi.fn() }, undefined);
    await vi.waitFor(() => expect(loader.loadedThreadsStore()).not.toBeNull());
    expect(ran).toEqual([]);
    expect(loader.loadedThreadsStore()?.getThread(5)?.id).toBe(5);
    expect(loader.loadedThreadsStore()?.threadsStore.getState().live.has(5)).toBe(false);

    // Once loaded the store stays in use and work runs at once.
    expect(loader.threadsStoreInUse()).toBe(true);
    expect(listSessionResets()).toContain("threads:store");
    loader.withThreadsStore(() => ran.push("now"));
    expect(ran).toEqual(["now"]);

    // A fetched starter row's thread reaches the store.
    loader.adoptStarterThreads([{ thread: makeThread({ id: 7, starter_message_id: 3 }) }]);
    expect(loader.loadedThreadsStore()?.getThread(7)?.id).toBe(7);
  });
});
