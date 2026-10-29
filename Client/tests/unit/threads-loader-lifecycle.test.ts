import { describe, expect, it, vi } from "vitest";
import { listSessionResets, runSessionResets } from "../../src/lib/sessionRegistry";
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
    await vi.waitFor(() => expect(loader.loadedThreadsStore()).not.toBeNull());
    expect(ran).toEqual([]);

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
