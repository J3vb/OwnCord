import { describe, expect, it } from "vitest";
import { listSessionResets, runSessionResets } from "../../src/lib/sessionRegistry";

// The store is loaded inside the test, so the registration it makes at load
// time is the one this test sees.
describe("blocks store session reset", () => {
  it("registers itself to be reset with the session, under its own name", async () => {
    const { blocksStore, setUserBlockedByMe } = await import("../../src/stores/blocks.store");
    expect(listSessionResets()).toContain("blocks:store");
    setUserBlockedByMe(3, true);
    expect(blocksStore.getState().blockedByMe.has(3)).toBe(true);
    expect(runSessionResets("user")).not.toContain("blocks:store");
    expect(blocksStore.getState().blockedByMe.size).toBe(0);
  });
});
