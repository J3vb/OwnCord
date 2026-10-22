import { describe, expect, it, vi } from "vitest";

// The threads store chunk fails to load once, then loads.
const state = vi.hoisted(() => ({ fail: true }));
vi.mock("../../src/stores/threads.store", async (importOriginal) => {
  if (state.fail) throw new Error("chunk load failed");
  return importOriginal();
});

describe("threadsLoader when the chunk fails to load", () => {
  it("keeps a queued delete, which still runs before a later change", async () => {
    const { withThreadsStore } = await import("../../src/stores/threadsLoader");
    const order: string[] = [];
    withThreadsStore(() => order.push("deleted"));
    await vi.dynamicImportSettled();
    expect(order).toEqual([]);

    state.fail = false;
    withThreadsStore(() => order.push("changed"));
    await vi.waitFor(() => expect(order).toEqual(["deleted", "changed"]));
  });
});
